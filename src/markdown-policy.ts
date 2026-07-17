export const blockedMarkdownUrl = (_url: string): string => "";

export const markdownImageLabel = (alt: string | undefined): string =>
  "[图片：" + (alt?.trim() || "未命名") + "]";
