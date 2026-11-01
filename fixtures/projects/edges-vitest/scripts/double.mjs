import { double } from "./lib/math.mjs";

process.stdout.write(String(double(Number(process.argv[2]))));
