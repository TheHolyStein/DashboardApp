import { chore } from './chore.js';
import { countdown } from './countdown.js';
import { flags } from './flags.js';
import { mention } from './mention.js';
import { pin } from './pin.js';
import { prep } from './prep.js';
import { remind } from './remind.js';
import { shopping } from './shopping.js';
import type { CommandPlugin } from './types.js';
import { wled } from './wled.js';

/** Every command, in the order their help is shown. Unknown `#`/`!` names match nothing and stay ordinary text. */
export const commands: readonly CommandPlugin[] = [mention, shopping, chore, remind, prep, countdown, pin, wled, flags];
