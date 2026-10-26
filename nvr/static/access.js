"use strict";

(() => {
  const root = typeof window !== "undefined" ? window : globalThis;
  const permissions = ["live", "recordings", "download", "cameras", "network", "settings", "system", "maintenance", "archive_delete"];
  let current = null;
  const copy = () => current ? {...current, permissions: [...current.permissions], camera_ids: [...current.camera_ids]} : null;
  const can = (permission) => permissions.includes(permission) && !!current && (current.role === "admin" || current.permissions.includes(permission));
  function setUser(value) {
    current = null;
    if (value && typeof value.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.id)
        && typeof value.username === "string" && value.enabled === true && ["admin", "user"].includes(value.role)
        && Array.isArray(value.permissions) && value.permissions.every((name) => permissions.includes(name))
        && ["all", "selected"].includes(value.camera_scope) && Array.isArray(value.camera_ids)
        && value.camera_ids.length <= 32 && value.camera_ids.every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id))) {
      current = {id: value.id, username: value.username, display_name: typeof value.display_name === "string" ? value.display_name : value.username,
        enabled: true, builtin: value.builtin === true, role: value.role,
        permissions: value.role === "admin" ? [...permissions] : [...new Set(value.permissions)],
        camera_scope: value.role === "admin" ? "all" : value.camera_scope, camera_ids: value.role === "admin" ? [] : [...new Set(value.camera_ids)]};
    }
    root.dispatchEvent?.(new CustomEvent("nvr-accesschange", {detail: {user: copy()}}));
    return !!current;
  }
  function settingsTabs() {
    return [...(can("settings") ? ["general", "languages", "recording"] : []),
      ...(can("system") || can("maintenance") || can("archive_delete") ? ["system"] : []), ...(current?.role === "admin" ? ["users"] : [])];
  }
  root.NvrAccess = Object.freeze({can, setUser, clear: () => setUser(null), user: copy, settingsTabs,
    isAdmin: () => current?.role === "admin",
    storageKey: (key) => current && current.id !== "builtin-admin" ? `${key}.user.${current.id}` : key,
    permissions: Object.freeze([...permissions]),
  });
  if (typeof module !== "undefined" && module.exports) module.exports = root.NvrAccess;
})();
