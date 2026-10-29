import { t } from "./i18n";

export const greet = (name: string) => `${t("greeting")}, ${name}`;
export const leave = (name: string) => `${t("farewell")}, ${name}`;
