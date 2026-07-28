import {DispatchError} from './dispatch-error.mts';

/** A command is defined or registered wrong — a bug in the plugin, fixed by editing the command file. */
export class DefinitionError extends DispatchError {
  override readonly name: string = 'DefinitionError';
}
