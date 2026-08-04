let currentProductMedia = [];
let currentProductMediaIndex = 0;

function normalizeMediaPath(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function getProductMedia(product) {
  const media = [];

  const images = Array.isArray(product.images)
    ? product.images
    : (product.image ? [product.image] : []);

  images.forEach((image, index) => {
    const src = normalizeMediaPath(image);
    if (!src) return;

    media.push({
      type: "image",
      src,
      alt: `${product.name || "Product"} image ${index + 1}`
    });
  });

  const videos = [];

  if (product.video) {
    videos.push(product.video);
  }

  if (Array.isArray(product.videos)) {
    videos.push(...product.videos);
  }

  videos.forEach((video, index) => {
    if (typeof video === "string") {
      const src = normalizeMediaPath(video);
      if (!src) return;

      media.push({
        type: "video",
        src,
        poster: "",
        title: `${product.name || "Product"} video ${index + 1}`
      });

      return;
    }

    if (!video || typeof video !== "object") return;

    const src = normalizeMediaPath(video.src);
    if (!src) return;

    media.push({
      type: "video",
      src,
      poster: normalizeMediaPath(video.poster),
      title: String(
        video.title ||
        `${product.name || "Product"} video ${index + 1}`
      )
    });
  });

  return media;
}

function encodeProductMedia(media) {
  // encodeURIComponent intentionally leaves apostrophes alone. These values are
  // used inside single-quoted inline handlers, so encode them explicitly too.
  return encodeURIComponent(JSON.stringify(media)).replace(/'/g, "%27");
}

function escapeMediaAttribute(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getProductCardMediaHtml(media, safeName, encodedMedia) {
  if (!media.length) {
    return "No Image or Video Yet";
  }

  const firstImage = media.find(item => item.type === "image");
  const firstVideo = media.find(item => item.type === "video");

  if (firstVideo) {
    const startIndex = media.indexOf(firstVideo);
    const safeSrc = escapeMediaAttribute(firstVideo.src);
    const safePoster = escapeMediaAttribute(
      firstVideo.poster || (firstImage ? firstImage.src : "")
    );

    return `
      <button
        type="button"
        class="product-media-trigger video-preview-trigger"
        onclick="openProductMedia('${encodedMedia}', ${startIndex})"
        aria-label="Open video gallery for ${safeName}"
      >
        <video
          class="product-card-video"
          src="${safeSrc}"
          ${safePoster ? `poster="${safePoster}"` : ""}
          autoplay
          muted
          loop
          playsinline
          preload="metadata"
          aria-hidden="true"
        ></video>
        <span class="video-available-badge">▶ Video</span>
      </button>
    `;
  }

  if (firstImage) {
    const startIndex = media.indexOf(firstImage);
    const safeSrc = escapeMediaAttribute(firstImage.src);

    return `
      <button
        type="button"
        class="product-media-trigger"
        onclick="openProductMedia('${encodedMedia}', ${startIndex})"
        aria-label="Open media gallery for ${safeName}"
      >
        <img src="${safeSrc}" alt="${safeName}">
      </button>
    `;
  }
}

function pauseCurrentLightboxVideo() {
  const video = document.querySelector("#lightbox-media video");

  if (video) {
    video.pause();
  }
}

function openProductMedia(encodedMedia, startIndex = 0) {
  try {
    currentProductMedia = JSON.parse(
      decodeURIComponent(encodedMedia)
    );
  } catch (error) {
    console.error("Unable to open product media:", error);
    return;
  }

  if (!Array.isArray(currentProductMedia) || !currentProductMedia.length) {
    return;
  }

  currentProductMediaIndex = Number.isInteger(Number(startIndex))
    ? Number(startIndex)
    : 0;

  if (
    currentProductMediaIndex < 0 ||
    currentProductMediaIndex >= currentProductMedia.length
  ) {
    currentProductMediaIndex = 0;
  }

  const lightbox = document.getElementById("lightbox");
  if (!lightbox) return;

  lightbox.classList.add("show");
  lightbox.setAttribute("aria-hidden", "false");
  document.body.classList.add("lightbox-open");

  renderCurrentProductMedia();
  renderProductMediaThumbnails();
}

function renderCurrentProductMedia() {
  if (!currentProductMedia.length) return;

  pauseCurrentLightboxVideo();

  const item = currentProductMedia[currentProductMediaIndex];
  const mediaContainer = document.getElementById("lightbox-media");

  mediaContainer.replaceChildren();

  if (item.type === "video") {
    const video = document.createElement("video");

    video.src = item.src;
    video.controls = true;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.setAttribute("aria-label", item.title || "Product video");

    if (item.poster) {
      video.poster = item.poster;
    }

    mediaContainer.appendChild(video);

    const playAttempt = video.play();
    if (playAttempt && typeof playAttempt.catch === "function") {
      playAttempt.catch(() => {
        // Browser autoplay policies may require the customer to press Play.
      });
    }
  } else {
    const image = document.createElement("img");

    image.src = item.src;
    image.alt = item.alt || "Full size product image";

    mediaContainer.appendChild(image);
  }

  document.getElementById("lightbox-counter").textContent =
    `${currentProductMediaIndex + 1} / ${currentProductMedia.length}`;

  updateActiveProductMediaThumbnail();
}

function renderProductMediaThumbnails() {
  const strip = document.getElementById("thumbnail-strip");
  strip.replaceChildren();

  currentProductMedia.forEach((item, index) => {
    const thumbnail = document.createElement("button");

    thumbnail.type = "button";
    thumbnail.className =
      "thumbnail" +
      (index === currentProductMediaIndex ? " active" : "");

    thumbnail.setAttribute(
      "aria-label",
      item.type === "video"
        ? `Open video ${index + 1}`
        : `Open image ${index + 1}`
    );

    if (item.type === "video") {
      thumbnail.classList.add("video-thumbnail");

      if (item.poster) {
        const poster = document.createElement("img");
        poster.src = item.poster;
        poster.alt = "Video thumbnail";
        thumbnail.appendChild(poster);
      }

      const playIcon = document.createElement("span");
      playIcon.className = "thumbnail-play-icon";
      playIcon.textContent = "▶";
      thumbnail.appendChild(playIcon);
    } else {
      const image = document.createElement("img");
      image.src = item.src;
      image.alt = `Thumbnail ${index + 1}`;
      thumbnail.appendChild(image);
    }

    thumbnail.addEventListener("click", () => {
      currentProductMediaIndex = index;
      renderCurrentProductMedia();
    });

    strip.appendChild(thumbnail);
  });
}

function updateActiveProductMediaThumbnail() {
  const thumbnails = document.querySelectorAll(".thumbnail");

  thumbnails.forEach((thumbnail, index) => {
    thumbnail.classList.toggle(
      "active",
      index === currentProductMediaIndex
    );
  });
}

function previousProductMedia() {
  if (!currentProductMedia.length) return;

  currentProductMediaIndex =
    (currentProductMediaIndex - 1 + currentProductMedia.length) %
    currentProductMedia.length;

  renderCurrentProductMedia();
}

function nextProductMedia() {
  if (!currentProductMedia.length) return;

  currentProductMediaIndex =
    (currentProductMediaIndex + 1) % currentProductMedia.length;

  renderCurrentProductMedia();
}

function closeProductMedia(event) {
  if (event) {
    event.stopPropagation();
  }

  pauseCurrentLightboxVideo();

  const lightbox = document.getElementById("lightbox");
  if (!lightbox) return;

  lightbox.classList.remove("show");
  lightbox.setAttribute("aria-hidden", "true");
  document.body.classList.remove("lightbox-open");
}

document.addEventListener("keydown", event => {
  const lightbox = document.getElementById("lightbox");

  if (!lightbox || !lightbox.classList.contains("show")) {
    return;
  }

  if (event.key === "Escape") {
    closeProductMedia();
  }

  if (event.key === "ArrowLeft") {
    previousProductMedia();
  }

  if (event.key === "ArrowRight") {
    nextProductMedia();
  }
});
