import { z } from "zod";

export const androidReleaseTagPattern = /^v(?:0|[1-9]\d{0,6})\.(?:0|[1-9]\d{0,6})\.(?:0|[1-9]\d{0,6})$/;
export const androidApkNamePattern = /^(?:app-release|app-(?:arm64-v8a|armeabi-v7a|x86|x86_64)-release)\.apk$/;
const maxBytes = 160 * 1024 * 1024;
export const androidReleaseManifest = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  draft: z.literal(false),
  prerelease: z.literal(false),
  tag_name: z.string().regex(androidReleaseTagPattern),
  name: z.string().max(512).optional(),
  assets: z.array(z.object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    name: z.string().regex(androidApkNamePattern),
    size: z.number().int().positive().max(maxBytes),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    browser_download_url: z.string().max(2048),
  })).min(1).max(5),
});
export type AndroidRelease = z.infer<typeof androidReleaseManifest>;
