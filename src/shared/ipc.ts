export const IPC_CHANNELS = {
  GET_SNAPSHOT: "app:get-snapshot",
  GET_VERSION: "app:get-version",
  CHECK_UPDATES: "app:check-updates",
  OPEN_EXTERNAL: "app:open-external",
  UPDATE_SETTINGS: "app:update-settings",
  ADD_LINKS: "queue:add-links",
  ADD_CONTAINERS: "queue:add-containers",
  CLEAR_ALL: "queue:clear-all",
  START: "queue:start",
  STOP: "queue:stop",
  TOGGLE_PAUSE: "queue:toggle-pause",
  CANCEL_PACKAGE: "queue:cancel-package",
  PICK_FOLDER: "dialog:pick-folder",
  PICK_CONTAINERS: "dialog:pick-containers",
  STATE_UPDATE: "state:update"
} as const;
