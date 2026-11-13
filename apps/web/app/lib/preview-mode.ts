export const isUiPreview =
  typeof import.meta.env !== "undefined" &&
  import.meta.env.VITE_CERTPATH_UI_PREVIEW === "true";
