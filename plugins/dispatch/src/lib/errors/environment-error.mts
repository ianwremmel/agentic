import {DispatchError} from './dispatch-error.mts';

/** A variable the command declared in `env` is missing. The command was right; the environment was not. */
export class EnvironmentError extends DispatchError {
  override readonly name: string = 'EnvironmentError';
  override readonly exitCode = 3;
}
