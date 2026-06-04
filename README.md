# Video Voice Annotation

A static React + Vite app for surgical video voice annotation. The user selects a short video, holds a large record button, and dictates while the video plays. Releasing the button pauses the video, stops microphone recording, and saves that audio as one chunk for the selected video.

## Workflow

1. Select one of the 10 videos.
2. Press and hold **Hold to record**.
3. While held, the app records microphone audio and plays the video.
4. Release, cancel, leave the button, switch tabs, or let the video end to stop both recording and playback.
5. Preview or download each audio chunk.
6. Review the captured transcript text when the browser supports speech recognition.
7. Download a JSON metadata file for the current video.
8. Send transcript JSON to Formspree.

Chunks are kept in browser memory for the current session and are separated by video. Closing or refreshing the page clears recorded chunks.

Audio is not sent anywhere by default. Audio remains in browser memory until the user downloads each chunk. The Formspree submit action sends transcript and metadata JSON only.

## Install

```bash
npm install
```

## Run Locally

```bash
npm run dev
```

Open the local Vite URL in a browser. Microphone recording requires a secure context: `localhost` is accepted by modern browsers, and deployed GitHub Pages sites use HTTPS.

## Video Manifest

This app does not store videos in the GitHub repository. It loads videos directly from Hugging Face using URLs defined in `src/videoManifest.js`.

The manifest currently points to:

```text
https://huggingface.co/datasets/nvidia/PhysicalAI-Robotics-Open-H-Embodiment/resolve/main/cmr-surgical-60hz-fixed/cholecystectomy/videos/chunk-000/observation.images.endoscope/episode_000000.mp4
```

through:

```text
episode_000009.mp4
```

Edit `src/videoManifest.js` if any filenames or hosting URLs need to change. Do not attempt to dynamically scan the Hugging Face folder from the browser.

## Transcript and Formspree Export

The app attempts to capture transcript text with the browser speech-recognition API while each audio chunk is recorded. When supported, each saved chunk includes:

- audio filename
- video start and end timestamps
- duration
- transcript text
- creation time

The **Send transcript JSON** button submits the current video's transcript package to:

```text
https://formspree.io/f/mnnlywpg
```

The submission includes readable form fields plus a `transcript_json` attachment containing the same JSON payload. Audio blobs are not uploaded to Formspree. Users can still download the original audio chunks from the app.

To use a different Formspree form, edit `FORMSPREE_ENDPOINT` in `src/App.jsx`.

## GitHub Pages Deployment

`vite.config.js` contains:

```js
export default defineConfig({
  base: "/REPOSITORY_NAME/",
  plugins: [react()],
});
```

Replace `REPOSITORY_NAME` with the actual GitHub repository name before building for GitHub Pages.

Then run:

```bash
npm run build
npm run deploy
```

The `deploy` script publishes `dist` with `gh-pages`.

## Why Hugging Face Hosting

Large video files should not be committed to GitHub. This app keeps the repository small by loading videos directly from Hugging Face direct download URLs in the manifest.

If direct Hugging Face playback fails on mobile Safari or another browser, download only the selected 10 videos and host them on an appropriate static storage/CDN service. Do not commit large video files directly to GitHub.

## Browser Compatibility

The app uses `MediaRecorder`, `getUserMedia`, pointer events, browser speech recognition, and HTML video playback.

- Current Chrome and Edge generally support `audio/webm`.
- Firefox generally supports `audio/webm`.
- Safari support has improved, but mobile Safari can be stricter about microphone permission, autoplay, MIME types, and remote video playback.
- The app checks supported recording MIME types and falls back from `audio/webm;codecs=opus` to `audio/webm`, `audio/mp4`, or `audio/mpeg` when supported.
- Transcript capture depends on `SpeechRecognition` or `webkitSpeechRecognition`. It is best supported in Chromium-based browsers and may be unavailable or inconsistent in Firefox and mobile Safari.

## Known Limitations

- Recordings are stored only in memory for the current browser session.
- Audio chunks are exported individually; the app does not merge chunks.
- Transcript capture is browser-dependent and may stop early or be unavailable even when audio recording works.
- Remote Hugging Face videos depend on network speed, CORS behavior, range request behavior, and browser playback support.
- Some mobile browsers may block `video.play()` after the microphone permission prompt. If that happens, tap the video once, then hold the record button again.

## Troubleshooting

### Microphone Permission Denied

Enable microphone permission for the site in browser settings and try again. On iPhone, also check iOS Settings for Safari or the installed browser.

### Video Does Not Load

Check the URL in `src/videoManifest.js`, the internet connection, and whether the browser can play the remote MP4 file. Try another video from the selector to isolate one bad URL.

### Recording Unsupported

Use a current browser that supports the `MediaRecorder` API. If `MediaRecorder` is missing, the app shows an unsupported recording message and disables hold-to-record.

### Transcript Unsupported

Use a current Chromium-based browser for the best transcript support. If browser speech recognition is missing, the app still records and downloads audio chunks, but transcript fields will be empty.

### Formspree Submission Fails

Confirm the endpoint in `FORMSPREE_ENDPOINT`, verify the Formspree form is active, and check that the browser is online. If your Formspree plan does not accept file attachments, use the `payload_json` field in the Formspree submission.

### Mobile Safari Issues

Use HTTPS or `localhost`, allow microphone access, keep the page visible while recording, and avoid low power or private browsing modes if recording behaves inconsistently. If Hugging Face streaming is unreliable, host the 10 selected videos on a static storage/CDN service.
