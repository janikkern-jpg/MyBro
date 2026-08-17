// Hilfsfunktionen für Bild-Anhänge im Chat (beide Modi).
//
// Was hier passiert:
//  1. Client-seitiges Verkleinern & Umkodieren auf JPEG (Qualität ~0.8),
//     damit ein 12-MP-Handyfoto nicht als 4 MB in die LLM-Anfrage geht.
//     Anthropic empfiehlt max. 1568 px längste Kante für Vision-Modelle.
//  2. Base64-Kodierung: wird direkt als Content-Block in die
//     Chat-Anfrage eingebettet ("source": "base64").
//  3. Parallel-Upload in den Supabase-Storage-Bucket "chat-images"
//     unter dem Pfad `{user_id}/{uuid}.jpg` – die resultierende
//     Public-URL landet später in messages.image_url bzw.
//     st_messages.image_url, damit das Bild im Verlauf erhalten bleibt.

import { supabase } from "../supabase";

export const IMAGE_MAX_DIMENSION = 1568;
export const IMAGE_JPEG_QUALITY = 0.8;
export const CHAT_IMAGES_BUCKET = "chat-images";

export type PreparedImage = {
  /** Verkleinerte JPEG-Datei (für den Storage-Upload). */
  blob: Blob;
  /** Nur der Base64-Teil (kein `data:…;base64,`-Prefix), für die LLM-Anfrage. */
  base64: string;
  /** Immer "image/jpeg" nach der Konvertierung. */
  mediaType: "image/jpeg";
  /** Pixel-Breite nach Verkleinerung. */
  width: number;
  /** Pixel-Höhe nach Verkleinerung. */
  height: number;
};

/**
 * Lädt eine Datei über einen `<img>`+`<canvas>`-Umweg, verkleinert sie
 * auf max. `IMAGE_MAX_DIMENSION` und exportiert sie als JPEG.
 *
 * Läuft komplett im Browser – ohne Netzwerk und ohne Abhängigkeiten.
 */
export async function prepareImageForChat(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Nur Bilddateien werden unterstützt.");
  }

  const bitmap = await loadBitmap(file);
  const { width, height } = fitInside(
    bitmap.width,
    bitmap.height,
    IMAGE_MAX_DIMENSION,
  );

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas-Kontext konnte nicht erstellt werden.");
  ctx.drawImage(bitmap, 0, 0, width, height);

  // Ressourcen freigeben, sobald das gezeichnete Bild im Canvas ist.
  if ("close" in bitmap && typeof bitmap.close === "function") {
    bitmap.close();
  }

  const blob = await canvasToJpegBlob(canvas, IMAGE_JPEG_QUALITY);
  const base64 = await blobToBase64(blob);

  return {
    blob,
    base64,
    mediaType: "image/jpeg",
    width,
    height,
  };
}

/**
 * Lädt eine Datei robust als `ImageBitmap` – bevorzugt via
 * `createImageBitmap`, fällt aber auf ein klassisches `<img>` zurück,
 * falls der Browser (v. a. mobile Safari) das nicht unterstützt.
 */
async function loadBitmap(
  file: File,
): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      // imageOrientation:"from-image" respektiert EXIF-Rotation von
      // Handyfotos, damit hochkant nicht als quer gezeigt wird.
      return await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
    } catch {
      // Weiter zum <img>-Fallback.
    }
  }
  return await loadHtmlImage(file);
}

function loadHtmlImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Bild konnte nicht geladen werden."));
    };
    img.src = url;
  });
}

function fitInside(
  width: number,
  height: number,
  maxDim: number,
): { width: number; height: number } {
  if (width <= maxDim && height <= maxDim) {
    return { width, height };
  }
  const scale = width >= height ? maxDim / width : maxDim / height;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function canvasToJpegBlob(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Canvas → JPEG fehlgeschlagen."));
      },
      "image/jpeg",
      quality,
    );
  });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  // In Chunks konvertieren, damit `String.fromCharCode(...)` bei
  // größeren Bildern nicht in die Call-Stack-Grenze läuft.
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...(slice as unknown as number[]));
  }
  return btoa(binary);
}

/**
 * Lädt ein bereits verkleinertes JPEG in den chat-images-Bucket
 * unter `{user_id}/{uuid}.jpg` hoch und liefert die public URL sowie
 * den Storage-Pfad zurück.
 */
export async function uploadChatImage(
  userId: string,
  blob: Blob,
): Promise<{ path: string; publicUrl: string }> {
  const uuid = randomId();
  const path = `${userId}/${uuid}.jpg`;

  const { error } = await supabase.storage
    .from(CHAT_IMAGES_BUCKET)
    .upload(path, blob, {
      contentType: "image/jpeg",
      cacheControl: "31536000",
      upsert: false,
    });
  if (error) {
    throw new Error(`Bild-Upload fehlgeschlagen: ${error.message}`);
  }

  const { data } = supabase.storage.from(CHAT_IMAGES_BUCKET).getPublicUrl(path);
  return { path, publicUrl: data.publicUrl };
}

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback für sehr alte Browser: nicht ganz so kryptografisch, aber
  // ausreichend obfuscated (verhindert praktisches Enumerieren).
  const arr = new Uint8Array(16);
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < 16; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}
