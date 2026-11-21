import { defineClient } from '@dash/module-kit';
import manifest from '../manifest.js';
import Tile from './Tile.svelte';
import Detail from './Detail.svelte';

// `detail: false` removes the shell's open-detail affordance for a tile without a detail view.
export default defineClient({ manifest, Tile, Detail });
