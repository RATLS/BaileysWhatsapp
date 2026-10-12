export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = "ApiError"
    // 0 = network error / API unreachable
    this.status = status
  }
}

// Small fetch wrapper that surfaces the server's own error text
// ({ error } or { message }) instead of a bare status code.
export function createApiClient(baseUrl) {
  async function request(method, path, body) {
    const init = { method }
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" }
      init.body = JSON.stringify(body)
    }

    let res
    try {
      res = await fetch(`${baseUrl}${path}`, init)
    } catch {
      throw new ApiError(`Cannot reach API at ${baseUrl}`, 0)
    }

    const data = await res.json().catch(() => null)
    if (!res.ok) {
      const detail = (data && (data.error || data.message)) || `request failed`
      throw new ApiError(`${detail} (HTTP ${res.status})`, res.status)
    }
    return data
  }

  return {
    baseUrl,
    get: (path) => request("GET", path),
    post: (path, body = {}) => request("POST", path, body),
    put: (path, body = {}) => request("PUT", path, body),
    del: (path) => request("DELETE", path),
  }
}

export function clientPath(clientId, suffix = "") {
  return `/clients/${encodeURIComponent(clientId)}${suffix}`
}
