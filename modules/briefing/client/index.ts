import { defineClient } from '@dash/module-kit';
import manifest from '../manifest.js';
import Tile from './Tile.svelte';
import Detail from './Detail.svelte';

export default defineClient({ manifest, Tile, Detail });
