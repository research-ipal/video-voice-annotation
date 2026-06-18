const BASE_URL =
  "https://huggingface.co/datasets/nvidia/PhysicalAI-Robotics-Open-H-Embodiment/resolve/main/Surgical/cmr_surgical/cholecystectomy/videos/chunk-000/observation.images.endoscope";
const VIDEO_URL_VERSION = "2026-06-18";

export const videos = Array.from({ length: 10 }, (_, index) => {
  const episodeNumber = String(index).padStart(6, "0");
  const videoNumber = String(index + 1).padStart(2, "0");

  return {
    id: `video${videoNumber}`,
    label: `Video ${index + 1}`,
    src: `${BASE_URL}/episode_${episodeNumber}.mp4?v=${VIDEO_URL_VERSION}`,
  };
});
