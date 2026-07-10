import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { videos } from "./videoManifest";

const RECORDING_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
];
const FORMSPREE_ENDPOINT = "https://formspree.io/f/mnnlywpg";

function getSupportedMimeType() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) {
    return "";
  }

  return RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function getExtension(mimeType) {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("mpeg")) return "mp3";
  return "webm";
}

function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) {
    return "0:00";
  }

  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function getSpeechRecognitionConstructor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition;
}

function normalizeTranscript(value) {
  return value.replace(/\s+/g, " ").trim();
}

function getTranscriptPayload(selectedVideo, currentChunks) {
  return {
    videoId: selectedVideo.id,
    videoLabel: selectedVideo.label,
    videoSrc: selectedVideo.src,
    exportedAt: new Date().toISOString(),
    chunks: currentChunks.map(
      ({
        chunkNumber,
        startVideoTime,
        endVideoTime,
        durationSeconds,
        filename,
        transcriptText,
        transcriptAvailable,
        createdAt,
      }) => ({
        chunkNumber,
        startVideoTime,
        endVideoTime,
        durationSeconds,
        filename,
        audioFilename: filename,
        transcriptText,
        transcriptAvailable,
        createdAt,
      }),
    ),
  };
}

async function resolvePlayableVideoUrl(src) {
  const response = await fetch(src, {
    method: "HEAD",
    mode: "cors",
  });

  if (!response.ok) {
    throw new Error(`Video resolver returned ${response.status}`);
  }

  return response.url || src;
}

async function fetchVideoAsBlobUrl(src, onProgress) {
  const response = await fetch(src, {
    method: "GET",
    mode: "cors",
  });

  if (!response.ok) {
    throw new Error(`Video download returned ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (!response.body?.getReader) {
    const blob = await response.blob();
    onProgress?.(100);
    return URL.createObjectURL(blob);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    chunks.push(value);
    receivedBytes += value.length;

    if (contentLength > 0) {
      onProgress?.(Math.min(99, Math.round((receivedBytes / contentLength) * 100)));
    }
  }

  const blob = new Blob(chunks, { type: response.headers.get("content-type") || "video/mp4" });
  onProgress?.(100);
  return URL.createObjectURL(blob);
}

function App() {
  const [selectedVideoId, setSelectedVideoId] = useState(videos[0].id);
  const [chunksByVideo, setChunksByVideo] = useState(() =>
    Object.fromEntries(videos.map((video) => [video.id, []])),
  );
  const [isRecording, setIsRecording] = useState(false);
  const [currentChunkSeconds, setCurrentChunkSeconds] = useState(0);
  const [currentVideoTime, setCurrentVideoTime] = useState(0);
  const [micStatus, setMicStatus] = useState("Microphone idle");
  const [appError, setAppError] = useState("");
  const [videoError, setVideoError] = useState("");
  const [resolvedVideoSrc, setResolvedVideoSrc] = useState("");
  const [videoDownloadProgress, setVideoDownloadProgress] = useState(null);
  const [videoStatus, setVideoStatus] = useState("Loading video...");
  const [showVideoPrimer, setShowVideoPrimer] = useState(false);
  const [transcriptStatus, setTranscriptStatus] = useState("Transcript idle");
  const [currentTranscript, setCurrentTranscript] = useState("");
  const [formStatus, setFormStatus] = useState("");
  const [formStatusType, setFormStatusType] = useState("success");
  const [isSubmittingTranscript, setIsSubmittingTranscript] = useState(false);

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const recognitionRef = useRef(null);
  const audioPartsRef = useRef([]);
  const finalTranscriptRef = useRef("");
  const interimTranscriptRef = useRef("");
  const startVideoTimeRef = useRef(0);
  const startWallTimeRef = useRef(0);
  const timerRef = useRef(null);
  const isRecordingRef = useRef(false);
  const isHoldActiveRef = useRef(false);
  const selectedVideoIdRef = useRef(selectedVideoId);
  const chunksByVideoRef = useRef(chunksByVideo);
  const blobVideoUrlRef = useRef("");

  const selectedVideo = useMemo(
    () => videos.find((video) => video.id === selectedVideoId) || videos[0],
    [selectedVideoId],
  );
  const playerVideoSrc = resolvedVideoSrc || selectedVideo.src;
  const currentChunks = chunksByVideo[selectedVideo.id] || [];
  const mediaRecorderSupported =
    typeof window !== "undefined" && Boolean(window.MediaRecorder);
  const speechRecognitionSupported =
    typeof window !== "undefined" && Boolean(getSpeechRecognitionConstructor());

  useEffect(() => {
    selectedVideoIdRef.current = selectedVideoId;
  }, [selectedVideoId]);

  useEffect(() => {
    chunksByVideoRef.current = chunksByVideo;
  }, [chunksByVideo]);

  const stopTimer = useCallback(() => {
    window.clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const startTimer = useCallback(() => {
    stopTimer();
    timerRef.current = window.setInterval(() => {
      const elapsed = (Date.now() - startWallTimeRef.current) / 1000;
      setCurrentChunkSeconds(elapsed);
      setCurrentVideoTime(videoRef.current?.currentTime || 0);
    }, 120);
  }, [stopTimer]);

  const getCurrentTranscriptText = useCallback(() => {
    return normalizeTranscript(
      `${finalTranscriptRef.current} ${interimTranscriptRef.current}`,
    );
  }, []);

  const stopSpeechRecognition = useCallback(() => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;

    if (recognition) {
      try {
        recognition.onend = null;
        recognition.onerror = null;
        recognition.onresult = null;
        recognition.stop();
      } catch {
        recognition.abort?.();
      }
    }

    setTranscriptStatus((previous) =>
      previous === "Listening for transcript..." ? "Transcript idle" : previous,
    );
  }, []);

  const startSpeechRecognition = useCallback(() => {
    if (!speechRecognitionSupported) {
      setTranscriptStatus("Transcript unsupported in this browser");
      return;
    }

    const SpeechRecognition = getSpeechRecognitionConstructor();
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    finalTranscriptRef.current = "";
    interimTranscriptRef.current = "";
    setCurrentTranscript("");

    recognition.onresult = (event) => {
      let interimText = "";

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const transcript = event.results[index][0]?.transcript || "";

        if (event.results[index].isFinal) {
          finalTranscriptRef.current = normalizeTranscript(
            `${finalTranscriptRef.current} ${transcript}`,
          );
        } else {
          interimText = `${interimText} ${transcript}`;
        }
      }

      interimTranscriptRef.current = normalizeTranscript(interimText);
      setCurrentTranscript(getCurrentTranscriptText());
    };

    recognition.onerror = (event) => {
      setTranscriptStatus(`Transcript unavailable: ${event.error || "speech error"}`);
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      if (isRecordingRef.current) {
        setTranscriptStatus("Transcript stopped by browser");
      } else {
        setTranscriptStatus("Transcript idle");
      }
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
      setTranscriptStatus("Listening for transcript...");
    } catch {
      setTranscriptStatus("Transcript could not be started");
    }
  }, [getCurrentTranscriptText, speechRecognitionSupported]);

  const stopRecording = useCallback(() => {
    if (!isRecordingRef.current) {
      return;
    }

    isRecordingRef.current = false;
    isHoldActiveRef.current = false;
    setIsRecording(false);
    setMicStatus("Stopping recording...");
    stopTimer();
    document.body.classList.remove("recording-lock");

    const video = videoRef.current;
    if (video) {
      video.pause();
      setCurrentVideoTime(video.currentTime || 0);
    }

    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }

    stopSpeechRecognition();
  }, [stopSpeechRecognition, stopTimer]);

  const startRecording = useCallback(async () => {
    if (!mediaRecorderSupported) {
      setAppError("This browser does not support MediaRecorder audio recording.");
      return;
    }

    if (isRecordingRef.current) {
      return;
    }

    const video = videoRef.current;
    if (!video) {
      setVideoError("Video is not ready yet.");
      return;
    }

    if (video.ended) {
      video.currentTime = 0;
    }

    isHoldActiveRef.current = true;
    setAppError("");

    try {
      setMicStatus("Requesting microphone...");
      if (!streamRef.current) {
        streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      if (!isHoldActiveRef.current) {
        return;
      }

      const mimeType = getSupportedMimeType();
      audioPartsRef.current = [];
      finalTranscriptRef.current = "";
      interimTranscriptRef.current = "";
      setCurrentTranscript("");
      setFormStatus("");
      startVideoTimeRef.current = video.currentTime || 0;
      startWallTimeRef.current = Date.now();

      const recorderOptions = mimeType ? { mimeType } : undefined;
      const recorder = new MediaRecorder(streamRef.current, recorderOptions);
      recorderRef.current = recorder;

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size > 0) {
          audioPartsRef.current.push(event.data);
        }
      });

      recorder.addEventListener("stop", () => {
        const endVideoTime = videoRef.current?.currentTime || startVideoTimeRef.current;
        const parts = audioPartsRef.current;
        const activeVideoId = selectedVideoIdRef.current;
        const activeVideo = videos.find((item) => item.id === activeVideoId) || videos[0];
        const resolvedMimeType = recorder.mimeType || mimeType || "audio/webm";
        const extension = getExtension(resolvedMimeType);
        const transcriptText = getCurrentTranscriptText();

        if (parts.length > 0) {
          setChunksByVideo((previous) => {
            const existingChunks = previous[activeVideoId] || [];
            const chunkNumber = existingChunks.length + 1;
            const filename = `${activeVideoId}_chunk${String(chunkNumber).padStart(
              2,
              "0",
            )}.${extension}`;
            const blob = new Blob(parts, { type: resolvedMimeType });
            const chunk = {
              blob,
              url: URL.createObjectURL(blob),
              mimeType: resolvedMimeType,
              filename,
              chunkNumber,
              startVideoTime: Number(startVideoTimeRef.current.toFixed(3)),
              endVideoTime: Number(endVideoTime.toFixed(3)),
              durationSeconds: Number(
                Math.max(0, endVideoTime - startVideoTimeRef.current).toFixed(3),
              ),
              transcriptText,
              transcriptAvailable: transcriptText.length > 0,
              createdAt: new Date().toISOString(),
            };

            return {
              ...previous,
              [activeVideoId]: [...existingChunks, chunk],
            };
          });
          setMicStatus("Recording saved");
        } else {
          setMicStatus("No audio captured");
        }

        audioPartsRef.current = [];
        recorderRef.current = null;
        setCurrentChunkSeconds(0);
      });

      recorder.start();
      isRecordingRef.current = true;
      setIsRecording(true);
      setMicStatus("Recording...");
      document.body.classList.add("recording-lock");
      startTimer();
      startSpeechRecognition();

      try {
        await video.play();
      } catch {
        setVideoError("Video playback was blocked. Try tapping the video once, then hold record again.");
        stopRecording();
      }
    } catch (error) {
      isHoldActiveRef.current = false;
      isRecordingRef.current = false;
      setIsRecording(false);
      document.body.classList.remove("recording-lock");

      if (error?.name === "NotAllowedError") {
        setMicStatus("Microphone permission denied");
        setAppError("Microphone permission was denied. Enable microphone access and try again.");
      } else if (error?.name === "NotFoundError") {
        setMicStatus("No microphone found");
        setAppError("No microphone was found on this device.");
      } else {
        setMicStatus("Microphone unavailable");
        setAppError("Microphone recording could not be started in this browser.");
      }
    }
  }, [
    getCurrentTranscriptText,
    mediaRecorderSupported,
    startSpeechRecognition,
    startTimer,
    stopRecording,
  ]);

  const handlePointerDown = useCallback(
    (event) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      startRecording();
    },
    [startRecording],
  );

  const handlePointerRelease = useCallback(
    (event) => {
      event.preventDefault();
      isHoldActiveRef.current = false;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      stopRecording();
    },
    [stopRecording],
  );

  const revokeBlobVideoUrl = useCallback(() => {
    if (blobVideoUrlRef.current) {
      URL.revokeObjectURL(blobVideoUrlRef.current);
      blobVideoUrlRef.current = "";
    }
  }, []);

  const primeVideoForSafari = useCallback(async () => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    setVideoError("");
    setVideoStatus("Downloading video for Safari...");
    setVideoDownloadProgress(0);
    setShowVideoPrimer(false);

    try {
      const blobUrl = await fetchVideoAsBlobUrl(selectedVideo.src, setVideoDownloadProgress);
      revokeBlobVideoUrl();
      blobVideoUrlRef.current = blobUrl;
      setResolvedVideoSrc(blobUrl);
      setVideoStatus("Loading local video...");
      setVideoDownloadProgress(null);
    } catch {
      setShowVideoPrimer(true);
      setVideoDownloadProgress(null);
      setVideoStatus("Safari video download failed. Try Open source MP4.");
    }
  }, [revokeBlobVideoUrl, selectedVideo.src]);

  const deleteLastChunk = useCallback(() => {
    setChunksByVideo((previous) => {
      const chunks = previous[selectedVideo.id] || [];
      if (chunks.length === 0) {
        return previous;
      }

      const deletedChunk = chunks[chunks.length - 1];
      URL.revokeObjectURL(deletedChunk.url);

      return {
        ...previous,
        [selectedVideo.id]: chunks.slice(0, -1),
      };
    });
  }, [selectedVideo.id]);

  const clearCurrentChunks = useCallback(() => {
    if (currentChunks.length === 0) {
      return;
    }

    const confirmed = window.confirm(`Clear all chunks for ${selectedVideo.label}?`);
    if (!confirmed) {
      return;
    }

    setChunksByVideo((previous) => {
      const chunks = previous[selectedVideo.id] || [];
      chunks.forEach((chunk) => URL.revokeObjectURL(chunk.url));
      return {
        ...previous,
        [selectedVideo.id]: [],
      };
    });
  }, [currentChunks.length, selectedVideo.id, selectedVideo.label]);

  const downloadMetadata = useCallback(() => {
    const metadata = getTranscriptPayload(selectedVideo, currentChunks);

    const blob = new Blob([JSON.stringify(metadata, null, 2)], {
      type: "application/json",
    });
    downloadBlob(blob, `${selectedVideo.id}_metadata.json`);
  }, [currentChunks, selectedVideo]);

  const submitTranscriptJson = useCallback(async () => {
    if (currentChunks.length === 0) {
      return;
    }

    const payload = getTranscriptPayload(selectedVideo, currentChunks);
    const payloadJson = JSON.stringify(payload, null, 2);

    setIsSubmittingTranscript(true);
    setFormStatusType("success");
    setFormStatus("Sending transcript JSON...");

    try {
      const response = await fetch(FORMSPREE_ENDPOINT, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          _subject: `${selectedVideo.label} transcript JSON`,
          source: "video-voice-annotation",
          video_id: selectedVideo.id,
          video_label: selectedVideo.label,
          chunk_count: currentChunks.length,
          payload_json: payloadJson,
          transcript_json: payload,
        }),
      });

      const result = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          result?.error ||
          result?.errors?.[0]?.message ||
          `Formspree responded with ${response.status}`;
        throw new Error(message);
      }

      setFormStatusType("success");
      setFormStatus("Transcript JSON sent to Formspree");
    } catch (error) {
      setFormStatusType("error");
      setFormStatus(`Transcript JSON could not be sent: ${error.message}`);
    } finally {
      setIsSubmittingTranscript(false);
    }
  }, [currentChunks, selectedVideo]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopRecording();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [stopRecording]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return undefined;
    }

    const handleEnded = () => {
      stopRecording();
      setVideoStatus("Video ended");
    };
    const handleLoadStart = () => setVideoStatus("Loading video...");
    const handleLoadedMetadata = () => {
      setVideoStatus("Ready");
      setShowVideoPrimer(false);
      setCurrentVideoTime(video.currentTime || 0);
    };
    const handleLoadedData = () => {
      setVideoStatus("Ready");
      setShowVideoPrimer(false);
    };
    const handleWaiting = () => {
      if (!video.paused) {
        setVideoStatus("Buffering video...");
      }
    };
    const handleCanPlay = () => {
      setVideoStatus("Ready");
      setShowVideoPrimer(false);
      setVideoError("");
    };
    const handleError = () => {
      const detail = video.error?.message ? ` ${video.error.message}` : "";
      setVideoStatus("Video error");
      setShowVideoPrimer(true);
      setVideoError(
        `Video could not be loaded from Hugging Face. Please check the URL, internet connection, or browser compatibility.${detail}`,
      );
      stopRecording();
    };
    const handleTimeUpdate = () => setCurrentVideoTime(video.currentTime || 0);

    video.addEventListener("ended", handleEnded);
    video.addEventListener("loadstart", handleLoadStart);
    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("loadeddata", handleLoadedData);
    video.addEventListener("waiting", handleWaiting);
    video.addEventListener("canplay", handleCanPlay);
    video.addEventListener("error", handleError);
    video.addEventListener("timeupdate", handleTimeUpdate);

    return () => {
      video.removeEventListener("ended", handleEnded);
      video.removeEventListener("loadstart", handleLoadStart);
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      video.removeEventListener("loadeddata", handleLoadedData);
      video.removeEventListener("waiting", handleWaiting);
      video.removeEventListener("canplay", handleCanPlay);
      video.removeEventListener("error", handleError);
      video.removeEventListener("timeupdate", handleTimeUpdate);
    };
  }, [playerVideoSrc, stopRecording]);

  useEffect(() => {
    stopRecording();
    setCurrentChunkSeconds(0);
    setCurrentVideoTime(0);
    setVideoError("");
    revokeBlobVideoUrl();
    setVideoDownloadProgress(null);
    setResolvedVideoSrc("");
    setVideoStatus("Loading video...");
    setShowVideoPrimer(false);
    setCurrentTranscript("");
    setFormStatus("");
    setFormStatusType("success");
  }, [revokeBlobVideoUrl, selectedVideoId, stopRecording]);

  useEffect(() => {
    let cancelled = false;

    setResolvedVideoSrc("");
    setVideoStatus("Resolving video source...");
    setVideoError("");
    setShowVideoPrimer(false);

    resolvePlayableVideoUrl(selectedVideo.src)
      .then((url) => {
        if (cancelled || blobVideoUrlRef.current) {
          return;
        }

        setResolvedVideoSrc(url);
        setVideoStatus("Loading video...");
      })
      .catch(() => {
        if (cancelled || blobVideoUrlRef.current) {
          return;
        }

        setResolvedVideoSrc("");
        setVideoStatus("Loading video...");
        setShowVideoPrimer(true);
        setVideoError(
          "The Hugging Face video source could not be resolved for embedded playback. Try Open source MP4, or mirror these videos to a static CDN.",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [selectedVideo.src]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return undefined;
    }

    video.load();
    const timer = window.setTimeout(() => {
      if (video.readyState === 0 && !video.error) {
        video.load();
      }
    }, 1000);

    return () => window.clearTimeout(timer);
  }, [playerVideoSrc]);

  useEffect(() => {
    if (
      (videoStatus !== "Loading video..." && videoStatus !== "Resolving video source...") ||
      videoError
    ) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setShowVideoPrimer(true);
      setVideoStatus("Tap Load video if Safari keeps this frame black.");
    }, 4500);

    return () => window.clearTimeout(timer);
  }, [playerVideoSrc, videoError, videoStatus]);

  useEffect(() => {
    return () => {
      stopTimer();
      stopSpeechRecognition();
      revokeBlobVideoUrl();
      document.body.classList.remove("recording-lock");
      streamRef.current?.getTracks().forEach((track) => track.stop());
      Object.values(chunksByVideoRef.current)
        .flat()
        .forEach((chunk) => URL.revokeObjectURL(chunk.url));
    };
  }, [revokeBlobVideoUrl, stopSpeechRecognition, stopTimer]);

  return (
    <main className="app-shell">
      <header className="app-header">
        <p className="eyebrow">Surgical video workflow</p>
        <h1>Video Voice Annotation</h1>
      </header>

      <section className="selector-panel" aria-label="Video selection">
        <label htmlFor="video-select">Selected video</label>
        <select
          id="video-select"
          value={selectedVideoId}
          disabled={isRecording}
          onChange={(event) => setSelectedVideoId(event.target.value)}
        >
          {videos.map((video) => (
            <option key={video.id} value={video.id}>
              {video.label}
            </option>
          ))}
        </select>
      </section>

      <section className="video-section" aria-label="Video player">
        <div className="video-frame">
          <video
            key={playerVideoSrc}
            ref={videoRef}
            crossOrigin="anonymous"
            playsInline
            preload="auto"
            controls
          >
            <source src={playerVideoSrc} type="video/mp4" />
          </video>
          {((videoStatus === "Loading video..." ||
            videoStatus === "Resolving video source..." ||
            showVideoPrimer) &&
            !videoError) ? (
            <div className={`video-overlay ${showVideoPrimer ? "" : "is-passive"}`}>
              <span>
                {showVideoPrimer ? "Safari may need a local copy." : "Loading video..."}
              </span>
              {showVideoPrimer ? (
                <button type="button" onClick={primeVideoForSafari}>
                  Load video locally
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="video-meta">
          <div>
            <h2>{selectedVideo.label}</h2>
            <p>
              {videoStatus}
              {videoDownloadProgress !== null ? ` ${videoDownloadProgress}%` : ""}
            </p>
          </div>
          <span>{formatTime(currentVideoTime)}</span>
        </div>
        {videoError ? <p className="message error">{videoError}</p> : null}
        {(showVideoPrimer || videoError) && (
          <div className="video-fallbacks">
            <button type="button" onClick={primeVideoForSafari}>
              Load local Safari copy
            </button>
            <a href={selectedVideo.src} target="_blank" rel="noreferrer">
              Open source MP4
            </a>
          </div>
        )}
      </section>

      <section className="status-grid" aria-label="Recording status">
        <div>
          <span>Microphone</span>
          <strong>{micStatus}</strong>
        </div>
        <div>
          <span>Transcript</span>
          <strong>{transcriptStatus}</strong>
        </div>
        <div>
          <span>Recording</span>
          <strong>{isRecording ? "Recording..." : "Idle"}</strong>
        </div>
        <div>
          <span>Current chunk</span>
          <strong>{formatTime(currentChunkSeconds)}</strong>
        </div>
      </section>

      {appError ? <p className="message error">{appError}</p> : null}
      {!mediaRecorderSupported ? (
        <p className="message error">
          This browser does not support MediaRecorder. Try a current Chrome, Edge,
          Firefox, or Safari release.
        </p>
      ) : null}
      {!speechRecognitionSupported ? (
        <p className="message warning">
          Transcript capture is not supported in this browser. Audio chunk recording and
          downloads still work.
        </p>
      ) : null}

      {isRecording || currentTranscript ? (
        <section className="transcript-panel" aria-label="Live transcript">
          <p className="eyebrow">Live transcript</p>
          <p>{currentTranscript || "Listening..."}</p>
        </section>
      ) : null}

      <section className="chunks-section" aria-label="Recorded audio chunks">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Current session</p>
            <h2>Audio chunks</h2>
          </div>
          <span>{currentChunks.length}</span>
        </div>

        {currentChunks.length === 0 ? (
          <p className="empty-state">No chunks recorded for this video.</p>
        ) : (
          <ol className="chunk-list">
            {currentChunks.map((chunk) => (
              <li key={`${selectedVideo.id}-${chunk.chunkNumber}`} className="chunk-item">
                <div className="chunk-details">
                  <strong>Chunk {chunk.chunkNumber}</strong>
                  <span>
                    {formatTime(chunk.startVideoTime)} to {formatTime(chunk.endVideoTime)}
                  </span>
                  <span>{formatTime(chunk.durationSeconds)} duration</span>
                  <span className="transcript-preview">
                    {chunk.transcriptText || "No transcript captured"}
                  </span>
                </div>
                <audio controls src={chunk.url} />
                <a className="download-link" href={chunk.url} download={chunk.filename}>
                  Download
                </a>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="export-section" aria-label="Export controls">
        <button type="button" onClick={downloadMetadata} disabled={currentChunks.length === 0}>
          Download metadata JSON
        </button>
        <button
          type="button"
          onClick={submitTranscriptJson}
          disabled={currentChunks.length === 0 || isSubmittingTranscript}
        >
          {isSubmittingTranscript ? "Sending..." : "Send transcript JSON"}
        </button>
        <button type="button" onClick={clearCurrentChunks} disabled={currentChunks.length === 0}>
          Clear all chunks
        </button>
      </section>
      {formStatus ? <p className={`message ${formStatusType}`}>{formStatus}</p> : null}

      <div className="record-dock">
        <button
          type="button"
          className={`record-button ${isRecording ? "is-recording" : ""}`}
          disabled={!mediaRecorderSupported || Boolean(videoError)}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerRelease}
          onPointerCancel={handlePointerRelease}
          onPointerLeave={handlePointerRelease}
        >
          <span>{isRecording ? "Recording..." : "Hold to record"}</span>
          <small>{isRecording ? formatTime(currentChunkSeconds) : "Video plays while held"}</small>
        </button>
        <button
          type="button"
          className="delete-button"
          onClick={deleteLastChunk}
          disabled={currentChunks.length === 0 || isRecording}
        >
          Delete last chunk
        </button>
      </div>
    </main>
  );
}

export default App;
