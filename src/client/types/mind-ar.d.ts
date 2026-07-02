// mind-ar ships no TypeScript declarations of its own (no "types"/"typings"
// field in its package.json). This declares only the surface this project
// actually uses, verified against the installed 1.2.5 bundle
// (node_modules/mind-ar/dist/mindar-image-three.prod.js) — not a blanket
// `any` stand-in for the whole library.
declare module 'mind-ar/dist/mindar-image-three.prod.js' {
  import type { WebGLRenderer, Scene, PerspectiveCamera, Group } from 'three';

  export interface MindARThreeOptions {
    container: HTMLElement;
    imageTargetSrc: string;
    maxTrack?: number;
    filterMinCF?: number;
    filterBeta?: number;
    warmupTolerance?: number;
    missTolerance?: number;
  }

  export interface MindARThreeAnchor {
    group: Group;
    targetIndex: number;
  }

  export class MindARThree {
    constructor(options: MindARThreeOptions);
    renderer: WebGLRenderer;
    scene: Scene;
    camera: PerspectiveCamera;
    addAnchor(targetIndex: number): MindARThreeAnchor;
    start(): Promise<void>;
    stop(): void;
  }
}
