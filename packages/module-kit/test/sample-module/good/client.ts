import { defineClient } from '../../../src/index.js';
import { goodManifest } from './manifest.js';
import Tile from './Tile.svelte';
import Detail from './Detail.svelte';

export const goodClient = defineClient({ manifest: goodManifest, Tile, Detail });
