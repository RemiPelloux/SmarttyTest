import { today } from "./dates.js";

export const header = (d: Date): string => `Report of ${today(d)}`;
