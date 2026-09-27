// dsh-theme-manager — node half: no-op host entry so a cordis row can mount the
// browser bundle. All behaviour lives in ./client.js.
export const name = "dsh-theme-manager";
export const inject = [];
export function apply() {
	console.log("[dsh-theme-manager] host half mounted (settings page lives in the browser half)");
}
