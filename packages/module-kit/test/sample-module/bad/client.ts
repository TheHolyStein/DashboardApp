import { defineClient } from '../../../src/index.js';
import { badManifest } from './server.js';
import Tile from './Tile.svelte';

// The bad tile doubles as the detail view.
export const badClient = defineClient({ manifest: badManifest, Tile, Detail: Tile });
