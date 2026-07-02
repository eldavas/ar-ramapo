// Asset system source of truth — AR_SYSTEM.md §E.
//
// As of Phase 1, this is load-bearing: src/client/main.ts resolves its
// active experience through ManifestResolver.ts (in this same directory)
// instead of referencing asset paths as string literals. Adding a target
// means adding an entry here, not editing application code.

export type ExperienceManifest = {
  targetId: string;
  riveUrl: string;
  modelUrl?: string;
  mindTargetUrl?: string;
  version: string;
};

export const experienceManifest: ExperienceManifest[] = [
  {
    targetId: 'proxy-target',
    riveUrl: '/assets/ui-test.riv',
    mindTargetUrl: '/assets/proxy-target.mind',
    version: '0.1.0',
  },
];
