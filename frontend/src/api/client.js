const API_BASE = '/api';

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request(method, path, body = null, extraHeaders = {}) {
  const url = `${API_BASE}${path}`;
  const headers = { ...extraHeaders };
  let fetchBody;

  if (body !== null && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(body);
  } else {
    fetchBody = body;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: fetchBody,
    credentials: 'include',
  });

  if (!res.ok) {
    let errMsg = 'Request failed';
    try {
      const data = await res.json();
      errMsg = data.error || errMsg;
    } catch {}
    throw new ApiError(errMsg, res.status);
  }

  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return null;
}

/**
 * Upload files with XHR so we can track upload progress.
 * @param {File[]} files
 * @param {string} currentPath - relative path inside user's storage
 * @param {(pct: number) => void} onProgress
 */
export function uploadFiles(files, currentPath, onProgress) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    for (const file of files) {
      formData.append('files', file);
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/files/upload?path=${encodeURIComponent(currentPath)}`);
    xhr.withCredentials = true;

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { resolve({}); }
      } else {
        let msg = 'Upload failed';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
        reject(new ApiError(msg, xhr.status));
      }
    });

    xhr.addEventListener('error', () => reject(new ApiError('Network error', 0)));
    xhr.send(formData);
  });
}

/** Inline preview URL — optional owner for shared files */
export function getFileUrl(filePath, owner) {
  const o = owner ? `&owner=${encodeURIComponent(owner)}` : '';
  return `${API_BASE}/files/view?path=${encodeURIComponent(filePath)}${o}`;
}

/** Thumbnail URL — optional owner for shared files */
export function getThumbnailUrl(filePath, owner) {
  const o = owner ? `&owner=${encodeURIComponent(owner)}` : '';
  return `${API_BASE}/files/thumbnail?path=${encodeURIComponent(filePath)}${o}`;
}

/** JPEG preview URL for RAW/DNG files — optional owner for shared files */
export function getPreviewUrl(filePath, owner) {
  const o = owner ? `&owner=${encodeURIComponent(owner)}` : '';
  return `${API_BASE}/files/preview?path=${encodeURIComponent(filePath)}${o}`;
}

/** Forced download URL — optional owner for shared files */
export function getDownloadUrl(filePath, owner) {
  const o = owner ? `&owner=${encodeURIComponent(owner)}` : '';
  return `${API_BASE}/files/download?path=${encodeURIComponent(filePath)}${o}`;
}

export const api = {
  get:    (path, body = null, headers = {}) => request('GET', path, body, headers),
  post:   (path, body, headers = {})  => request('POST', path, body, headers),
  delete: (path, body, headers = {})  => request('DELETE', path, body, headers),
};

/** Shares API helpers */
export const sharesApi = {
  getUsers:     ()           => api.get('/shares/users'),
  getWithMe:    ()           => api.get('/shares/with-me'),
  getForFolder: (folderPath) => api.get(`/shares?path=${encodeURIComponent(folderPath)}`),
  save:         (folderPath, userIds) => api.post('/shares', { path: folderPath, userIds }),
  
  // Public sharing configuration (for owner)
  getPublic:    (folderPath) => api.get(`/shares/public?path=${encodeURIComponent(folderPath)}`),
  savePublic:   (config)     => api.post('/shares/public', config),
};

/** Public Share Guest APIs */
export const publicSharesApi = {
  getInfo: (alias) => request('GET', `/public/shares/info/${alias}`),
  unlock: (alias, password) => request('POST', `/public/shares/unlock/${alias}`, { password }),
  list: (alias, path, token) => {
    const headers = token ? { 'x-public-share-token': token } : {};
    return request('GET', `/public/shares/list/${alias}?path=${encodeURIComponent(path || '')}`, null, headers);
  },
  mkdir: (alias, path, token) => {
    const headers = token ? { 'x-public-share-token': token } : {};
    return request('POST', `/public/shares/mkdir/${alias}`, { path }, headers);
  },
  delete: (alias, paths, token) => {
    const headers = token ? { 'x-public-share-token': token } : {};
    return request('DELETE', `/public/shares/delete/${alias}`, { paths }, headers);
  },
  rename: (alias, path, newName, token) => {
    const headers = token ? { 'x-public-share-token': token } : {};
    return request('POST', `/public/shares/rename/${alias}`, { path, newName }, headers);
  },
  copy: (alias, paths, targetDir, token) => {
    const headers = token ? { 'x-public-share-token': token } : {};
    return request('POST', `/public/shares/copy/${alias}`, { paths, targetDir }, headers);
  },
  move: (alias, paths, targetDir, token) => {
    const headers = token ? { 'x-public-share-token': token } : {};
    return request('POST', `/public/shares/move/${alias}`, { paths, targetDir }, headers);
  }
};

/**
 * Upload files to a public share with progress tracking.
 */
export function uploadPublicFiles(files, alias, currentPath, token, onProgress) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    for (const file of files) {
      formData.append('files', file);
    }

    const xhr = new XMLHttpRequest();
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
    xhr.open('POST', `${API_BASE}/public/shares/upload/${alias}?path=${encodeURIComponent(currentPath)}${tokenParam}`);
    xhr.withCredentials = true;

    if (token) {
      xhr.setRequestHeader('x-public-share-token', token);
    }

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { resolve({}); }
      } else {
        let msg = 'Upload failed';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
        reject(new ApiError(msg, xhr.status));
      }
    });

    xhr.addEventListener('error', () => reject(new ApiError('Network error', 0)));
    xhr.send(formData);
  });
}

/**
 * AI-powered file search.
 * @param {string} query - Natural language or tag search term
 * @returns {Promise<{results: Array, total: number, query: string}>}
 */
export function searchFiles(query) {
  return request('GET', `/files/search?q=${encodeURIComponent(query)}`);
}

/** Admin User Management APIs */
export const adminApi = {
  getPendingUsers: () => api.get('/auth/pending'),
  approveUser:     (userId) => api.post(`/auth/approve/${userId}`),
  rejectUser:      (userId) => api.post(`/auth/reject/${userId}`),
};


