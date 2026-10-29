import { send } from "./mailer";

export const notify = (to: string) => send(to);
