import { MeshoptDecoder } from './meshopt_decoder.mjs';

const button = document.getElementById('go');
const statusBox = document.getElementById('status');
function status(text, kind = 'warning') {
  statusBox.textContent = text;
  statusBox.className = `status visible ${kind}`;
}
function progress() { statusBox.textContent = ''; statusBox.className = 'status'; }
function errorKind(message) {
  return /обнови страницу|обнови вкладку|не вижу запрос|сначала открой|истекла|дождись/i.test(message) ? 'warning' : 'error';
}

function align4(n) { return (n + 3) & ~3; }
function readU32(view, offset) { return view.getUint32(offset, true); }
function writeU32(view, offset, value) { view.setUint32(offset, value, true); }

function parseGlb(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.byteLength < 20) throw new Error('Файл слишком маленький для GLB.');
  const view = new DataView(arrayBuffer);
  if (readU32(view, 0) !== 0x46546c67) throw new Error('Это не GLB-файл (неверная сигнатура).');
  if (readU32(view, 4) !== 2) throw new Error('Поддерживается GLB версии 2.');
  const declaredLength = readU32(view, 8);
  if (declaredLength > bytes.byteLength || declaredLength < 20) throw new Error('Повреждён заголовок GLB.');
  let offset = 12, json = null, bin = new Uint8Array(0);
  while (offset + 8 <= declaredLength) {
    const length = readU32(view, offset);
    const type = readU32(view, offset + 4);
    const start = offset + 8, end = start + length;
    if (end > declaredLength) throw new Error('Повреждённая структура GLB: chunk выходит за пределы файла.');
    if (type === 0x4e4f534a) {
      const text = new TextDecoder().decode(bytes.subarray(start, end)).replace(/\0+$/g, '').trim();
      json = JSON.parse(text);
    } else if (type === 0x004e4942) {
      bin = bytes.slice(start, end);
    }
    offset = end;
  }
  if (!json) throw new Error('В GLB не найден JSON chunk.');
  return { json, bin };
}

async function convertMeshoptGlb(arrayBuffer) {
  const { json, bin } = parseGlb(arrayBuffer);
  const views = json.bufferViews || [];
  const compressed = views.filter(v => v.extensions?.EXT_meshopt_compression);
  if (!compressed.length) return { buffer: arrayBuffer, converted: false };

  status(`Найдено Meshopt-сжатие: ${compressed.length} буферных областей. Подготавливаю декодер…`);
  await MeshoptDecoder.ready;
  if (!MeshoptDecoder.supported) throw new Error('Браузер не поддерживает WASM-декодер Meshopt.');

  const buffers = json.buffers || [];
  const sourceForBuffer = (bufferIndex) => {
    if (bufferIndex === 0 && buffers[0] && !buffers[0].uri) return bin;
    throw new Error('Модель использует внешний или дополнительный бинарный буфер, который пока не поддерживается.');
  };

  const pieces = [];
  let totalLength = 0;
  for (let i = 0; i < views.length; i++) {
    const bv = views[i];
    const ext = bv.extensions?.EXT_meshopt_compression;
    let data;
    if (ext) {
      const sourceBuffer = sourceForBuffer(ext.buffer ?? 0);
      const srcOffset = ext.byteOffset || 0;
      const srcEnd = srcOffset + ext.byteLength;
      if (srcOffset < 0 || ext.byteLength < 0 || srcEnd > sourceBuffer.byteLength) {
        throw new Error(`Meshopt-область ${i} выходит за пределы бинарного буфера.`);
      }
      const source = sourceBuffer.subarray(srcOffset, srcEnd);
      const count = ext.count;
      const stride = ext.byteStride;
      if (!Number.isInteger(count) || count < 0 || !Number.isInteger(stride) || stride < 1) {
        throw new Error(`Некорректные параметры Meshopt в области ${i}.`);
      }
      const target = new Uint8Array(count * stride);
      MeshoptDecoder.decodeGltfBuffer(target, count, stride, source, ext.mode, ext.filter || 'NONE');
      data = target;
      bv.byteStride = stride;
      if (bv.target === undefined && ext.mode === 'ATTRIBUTES') {
        // target is optional in glTF and should remain absent when not originally specified.
      }
      if (bv.extensions) {
        delete bv.extensions.EXT_meshopt_compression;
        if (!Object.keys(bv.extensions).length) delete bv.extensions;
      }
      bv.byteLength = data.byteLength;
    } else {
      const bufferIndex = bv.buffer ?? 0;
      const sourceBuffer = sourceForBuffer(bufferIndex);
      const start = bv.byteOffset || 0;
      const end = start + bv.byteLength;
      if (start < 0 || end > sourceBuffer.byteLength) throw new Error(`Буферная область ${i} выходит за пределы файла.`);
      data = sourceBuffer.slice(start, end);
    }

    const aligned = align4(totalLength);
    pieces.push({ offset: aligned, data });
    totalLength = aligned + data.byteLength;
  }

  const newBin = new Uint8Array(align4(totalLength));
  pieces.forEach((p, i) => {
    newBin.set(p.data, p.offset);
    views[i].buffer = 0;
    views[i].byteOffset = p.offset;
  });

  json.buffers = [{ byteLength: newBin.byteLength }];
  if (Array.isArray(json.extensionsRequired)) {
    json.extensionsRequired = json.extensionsRequired.filter(name => name !== 'EXT_meshopt_compression');
    if (!json.extensionsRequired.length) delete json.extensionsRequired;
  }
  if (Array.isArray(json.extensionsUsed)) {
    json.extensionsUsed = json.extensionsUsed.filter(name => name !== 'EXT_meshopt_compression');
    if (!json.extensionsUsed.length) delete json.extensionsUsed;
  }

  // Keep JSON chunk 4-byte aligned and rebuild a standards-compliant GLB 2.0 container.
  const jsonBytesRaw = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = align4(jsonBytesRaw.byteLength);
  const binLength = align4(newBin.byteLength);
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const output = new ArrayBuffer(total);
  const outBytes = new Uint8Array(output);
  const outView = new DataView(output);
  writeU32(outView, 0, 0x46546c67);
  writeU32(outView, 4, 2);
  writeU32(outView, 8, total);
  writeU32(outView, 12, jsonLength);
  writeU32(outView, 16, 0x4e4f534a);
  outBytes.fill(0x20, 20, 20 + jsonLength);
  outBytes.set(jsonBytesRaw, 20);
  const binHeader = 20 + jsonLength;
  writeU32(outView, binHeader, binLength);
  writeU32(outView, binHeader + 4, 0x004e4942);
  outBytes.set(newBin.subarray(0, binLength), binHeader + 8);
  return { buffer: output, converted: true, count: compressed.length };
}

button.addEventListener('click', async () => {
  button.disabled = true;
  progress();
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab?.id || !tab.url?.startsWith('https://studio.tripo3d.ai/')) {
      status('Открой страницу модели Tripo и попробуй снова.', 'warning');
      return;
    }

    let pageUrls = [];
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {type: 'TRIPO_FIND_GLB'});
      pageUrls = response?.urls || [];
    } catch (_) {
      try {
        const injected = await chrome.scripting.executeScript({
          target: {tabId: tab.id},
          func: () => performance.getEntriesByType('resource').map(e => e.name).filter(raw => {
            try { const u = new URL(raw); return u.hostname === 'tripo-data.rg1.data.tripo3d.com' && /\.glb$/i.test(u.pathname); }
            catch (_) { return false; }
          })
        });
        pageUrls = injected?.[0]?.result || [];
      } catch (_) {}
    }

    let capturedUrls = [];
    try {
      const captured = await chrome.runtime.sendMessage({type: 'TRIPO_GET_CAPTURED_URLS'});
      capturedUrls = captured?.urls || [];
    } catch (_) {}

    const urls = [...new Set([...pageUrls, ...capturedUrls])];
    if (!urls.length) {
      status('Не вижу ссылку на модель. Закрой окно расширения, обнови страницу Tripo, дождись загрузки 3D-превью и попробуй снова.', 'warning');
      return;
    }

    const url = urls.find(u => /meshopt/i.test(new URL(u).pathname)) || urls[0];
    const parsed = new URL(url);
    if (parsed.hostname !== 'tripo-data.rg1.data.tripo3d.com' || !/\.glb$/i.test(parsed.pathname)) {
      status('Найдена ссылка неожиданного формата. Скачивание отменено.', 'error');
      return;
    }

    progress();
    const response = await fetch(url, {credentials: 'omit', cache: 'no-store'});
    if (!response.ok) throw new Error(`Tripo вернул HTTP ${response.status}. Возможно, подписанная ссылка уже истекла — обнови страницу модели.`);
    const source = await response.arrayBuffer();
    progress();
    const result = await convertMeshoptGlb(source);
    const blob = new Blob([result.buffer], {type: 'model/gltf-binary'});
    const objectUrl = URL.createObjectURL(blob);
    const filename = (parsed.pathname.split('/').pop() || 'tripo-model.glb')
      .replace(/\.glb$/i, '').replace(/[^\w.\-]+/g, '_') + (result.converted ? '_Blender.glb' : '_Blender.glb');
    try {
      await chrome.downloads.download({url: objectUrl, filename, saveAs: true});
      status('ГОТОВО', 'success');
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    } catch (downloadError) {
      URL.revokeObjectURL(objectUrl);
      throw downloadError;
    }
  } catch (e) {
    const message = e?.message || String(e);
    status(/обнови страницу|истекла|HTTP 403|HTTP 401/i.test(message) ? `Обнови страницу Tripo и попробуй снова.\n${message}` : `Ошибка: ${message}`, errorKind(message));
  } finally {
    button.disabled = false;
  }
});
