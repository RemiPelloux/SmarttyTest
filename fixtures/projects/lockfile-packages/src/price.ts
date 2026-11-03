import { money } from "money-lib";

export const price = (cents: number): string => money(cents);
