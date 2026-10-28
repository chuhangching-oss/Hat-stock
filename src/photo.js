// ===== 款式照片上傳（前端壓縮 + 傳給後端存 Google Drive）=====

import { gasRequest, getGasUrl } from './api';

/**
 * 把手機拍的照片壓縮成正方形邊長 <= maxDim 的 JPEG（dataURL）
 * 約可從 3000px/5MB 壓到 ~200KB，上傳快、手機流量省
 */
export function compressImage(file, { maxDim = 1280, quality = 0.72 } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('讀取圖片失敗'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('圖片解析失敗（請換一張試試）'));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/** 上傳某品號的款式照片 → 回傳 { item_code, photo_url, file_id, item } */
export async function uploadItemPhoto(itemCode, file) {
  const data = await compressImage(file);
  return gasRequest(getGasUrl(), {
    action: 'upload_photo',
    item_code: itemCode,
    data,
    filename: file.name || 'photo.jpg',
  });
}
