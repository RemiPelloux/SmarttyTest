import { mean } from "./stats";

export const report = (xs: number[]) => `mean=${mean(xs)}`;
