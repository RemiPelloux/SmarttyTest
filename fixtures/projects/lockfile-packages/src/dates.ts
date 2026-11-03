import { format } from "date-lib";

export const today = (d: Date): string => format(d, "yyyy-MM-dd");
