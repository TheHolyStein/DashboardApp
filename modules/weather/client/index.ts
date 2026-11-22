import { defineClient } from '@dash/module-kit';
import manifest from '../manifest.js';
import Tile from './Tile.svelte';
import Detail from './Detail.svelte';
import Settings from './Settings.svelte';

// `Settings` replaces the generated form: the location needs a place search.
export default defineClient({ manifest, Tile, Detail, Settings });
