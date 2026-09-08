class TokenManager {
  constructor() {
    this.accessToken = null;
    this.tokenExpiryTime = null;
    this.initialized = false;
    this.initPromise = null;

    this.pendingRequests = new Set();
    this.refreshPromise = null;
    this.lastRefreshTime = 0;
    this.refreshCooldown = 10000;

    this.tokenCache = {
      value: null,
      timestamp: 0,
      duration: 5000,
    };

    this.loginPaths = new Set(["/auth/login", "/auth/register"]);
    this.currentPath = window.location.pathname;
  }

  async initialize() {
    if (this.initialized) return this.accessToken !== null;

    if (this.initPromise) return this.initPromise;

    this.initPromise = this._initialize();

    try {
      const result = await this.initPromise;
      return result;
    } finally {
      this.initPromise = null;
    }
  }

  async _initialize() {
    try {
      const hasStoredToken = this.loadTokenFromStorage();

      if (hasStoredToken && this.isValid()) {
        this.initialized = true;

        if (this.shouldRefreshEarly()) {
          try {
            await this.refreshAccessToken();
          } catch (error) {}
        }

        return true;
      }

      if (hasStoredToken && !this.isValid()) {
        this.clearToken();
      }

      const token = await this.silentRefreshWithTimeout(3000);

      if (token) {
        this.setToken(token);

        if (this.shouldRefreshEarly()) {
          try {
            await this.refreshAccessToken();
          } catch (error) {}
        }

        this.initialized = true;
        return true;
      }

      this.initialized = true;
      return false;
    } catch (error) {
      this.initialized = true;

      if (error.message === "SESSION_EXPIRED" && !this.isOnLoginPage()) {
        this.redirectToLogin();
      }

      return false;
    }
  }

  async silentRefreshWithTimeout(timeoutMs) {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("REFRESH_TIMEOUT")), timeoutMs);
    });

    try {
      return await Promise.race([this.silentRefresh(), timeoutPromise]);
    } catch (error) {
      if (error.message === "REFRESH_TIMEOUT") {
        throw new Error("SESSION_EXPIRED");
      }
      throw error;
    }
  }

  shouldRefreshEarly() {
    if (!this.tokenExpiryTime) return true;
    const timeUntilExpiry = this.tokenExpiryTime - Date.now();
    return timeUntilExpiry < 5 * 60 * 1000;
  }

  isOnLoginPage() {
    return this.loginPaths.has(this.currentPath);
  }

  redirectToLogin() {
    if (!this.isOnLoginPage()) {
      window.location.replace("/auth/login");
    }
  }

  async waitForInit() {
    if (this.initialized) return this.accessToken !== null;
    return this.initialize();
  }

  getTokenExpiry(token) {
    try {
      if (!token) return null;
      const payload = JSON.parse(atob(token.split(".")[1]));
      return payload.exp ? payload.exp * 1000 : null;
    } catch {
      return null;
    }
  }

  isTokenExpired() {
    if (!this.tokenExpiryTime) return true;
    return Date.now() >= this.tokenExpiryTime - 10000;
  }

  async silentRefresh() {
    try {
      const response = await fetch("/auth/refresh", {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-cache",
        },
      });

      if (response.status === 401) {
        this.clearToken();
        throw new Error("SESSION_EXPIRED");
      }

      if (!response.ok) {
        throw new Error("REFRESH_FAILED");
      }

      const data = await response.json();

      if (data.success && data.accessToken) {
        this.setToken(data.accessToken);
        return data.accessToken;
      }

      throw new Error("NO_TOKEN");
    } catch (error) {
      if (error.message === "SESSION_EXPIRED") {
        this.clearToken();
      }
      throw error;
    }
  }

  setToken(token) {
    this.accessToken = token;
    this.tokenExpiryTime = this.getTokenExpiry(token);
    this.tokenCache.value = token;
    this.tokenCache.timestamp = Date.now();

    try {
      sessionStorage.setItem("accessToken", token);
      sessionStorage.setItem("tokenExpiryTime", this.tokenExpiryTime);
    } catch (e) {}
  }

  clearToken() {
    this.accessToken = null;
    this.tokenExpiryTime = null;
    this.tokenCache.value = null;
    this.tokenCache.timestamp = 0;

    try {
      sessionStorage.removeItem("accessToken");
      sessionStorage.removeItem("tokenExpiryTime");
    } catch (e) {}
  }

  loadTokenFromStorage() {
    try {
      const token = sessionStorage.getItem("accessToken");
      const expiryTime = sessionStorage.getItem("tokenExpiryTime");

      if (token && expiryTime) {
        this.accessToken = token;
        this.tokenExpiryTime = parseInt(expiryTime);
        this.tokenCache.value = token;
        this.tokenCache.timestamp = Date.now();
        return true;
      }
    } catch (e) {}

    return false;
  }

  async refreshAccessToken() {
    const now = Date.now();

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    if (now - this.lastRefreshTime < this.refreshCooldown) {
      if (this.accessToken && !this.isTokenExpired()) {
        return this.accessToken;
      }
    }

    this.lastRefreshTime = now;

    this.refreshPromise = (async () => {
      try {
        const token = await this.silentRefresh();
        this.resolvePendingRequests(null, token);
        return token;
      } catch (error) {
        this.clearToken();
        this.resolvePendingRequests(error, null);

        if (error.message === "SESSION_EXPIRED") {
          this.redirectToLogin();
        }

        throw error;
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  addPendingRequest() {
    return new Promise((resolve, reject) => {
      this.pendingRequests.add({ resolve, reject });
    });
  }

  resolvePendingRequests(error, token) {
    const requests = Array.from(this.pendingRequests);
    this.pendingRequests.clear();

    requests.forEach(({ resolve, reject }) => {
      if (error) {
        reject(error);
      } else {
        resolve(token);
      }
    });
  }

  getAccessToken() {
    const now = Date.now();

    if (
      this.tokenCache.value &&
      now - this.tokenCache.timestamp < this.tokenCache.duration
    ) {
      return this.tokenCache.value;
    }

    if (this.accessToken && !this.isTokenExpired()) {
      this.tokenCache.value = this.accessToken;
      this.tokenCache.timestamp = now;
      return this.accessToken;
    }

    return null;
  }

  isValid() {
    return this.accessToken !== null && !this.isTokenExpired();
  }

  getToken() {
    return this.isValid() ? this.accessToken : null;
  }

  async fetchWithAuth(url, options = {}) {
    await this.waitForInit();

    const makeRequest = async (token) => {
      const headers = {
        ...options.headers,
        Accept: "application/json",
        "Cache-Control": "no-cache",
      };

      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      return fetch(url, {
        ...options,
        credentials: "include",
        headers,
      });
    };

    let token = this.getAccessToken();

    if (token) {
      const response = await makeRequest(token);

      if (response.status !== 401) {
        return response;
      }

      this.clearToken();
    }

    try {
      const newToken = await this.refreshAccessToken();

      if (newToken) {
        const retryResponse = await makeRequest(newToken);

        if (retryResponse.status === 401) {
          throw new Error("SESSION_EXPIRED");
        }

        return retryResponse;
      }
    } catch (error) {
      if (error.message === "SESSION_EXPIRED") {
        this.redirectToLogin();
      }
      throw error;
    }

    return makeRequest(null);
  }
}

const tokenManager = new TokenManager();

function getAccessToken() {
  return tokenManager.getAccessToken();
}

function scheduleTokenRefresh() {
  const CHECK_INTERVAL = 60 * 1000;
  const REFRESH_THRESHOLD = 5 * 60 * 1000;

  const checkAndRefresh = async () => {
    if (!tokenManager.isValid()) return;

    const tokenExpiry = tokenManager.tokenExpiryTime;
    if (!tokenExpiry) return;

    const timeUntilExpiry = tokenExpiry - Date.now();

    if (timeUntilExpiry < REFRESH_THRESHOLD) {
      try {
        await tokenManager.refreshAccessToken();
      } catch (error) {
        console.debug("Preventive refresh failed:", error);
      }
    }
  };

  setInterval(checkAndRefresh, CHECK_INTERVAL);
}

(async function init() {
  try {
    if (tokenManager.isOnLoginPage()) {
      try {
        const refreshed = await tokenManager.refreshAccessToken();
        if (refreshed) {
          const redirect = new URLSearchParams(window.location.search).get(
            "redirect",
          );
          window.location.replace(redirect || "/");
        }
      } catch (error) {}
      return;
    }

    const hasStoredToken = tokenManager.loadTokenFromStorage();

    if (hasStoredToken && tokenManager.isValid()) {
      tokenManager.initialized = true;

      if (tokenManager.shouldRefreshEarly()) {
        try {
          await tokenManager.refreshAccessToken();
        } catch (error) {}
      }

      scheduleTokenRefresh();
      return;
    }

    if (hasStoredToken && !tokenManager.isValid()) {
      tokenManager.clearToken();
    }

    const isValid = await tokenManager.waitForInit();

    if (!isValid) {
      tokenManager.redirectToLogin();
    } else {
      scheduleTokenRefresh();
    }
  } catch (error) {
    if (!tokenManager.isOnLoginPage()) {
      tokenManager.redirectToLogin();
    }
  }
})();

window.tokenManager = tokenManager;
window.getAccessToken = getAccessToken;
window.fetchWithAuth = tokenManager.fetchWithAuth.bind(tokenManager);
window.refreshAccessToken = tokenManager.refreshAccessToken.bind(tokenManager);
