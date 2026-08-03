import {CommandError} from './command-error.mts';

/** A command is defined or registered wrong — a bug in the plugin, fixed by editing the command file. */
export class DefinitionError extends CommandError {
  override readonly name: string = 'DefinitionError';
}
