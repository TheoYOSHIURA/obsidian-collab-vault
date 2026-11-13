// Remplace le module « obsidian » dans les tests Node (seul ce qu'utilise gitsetup.ts).
export const Platform = { isDesktopApp: true };
export class Modal {}
export class Notice {}
export class Setting {}
export class App {}
