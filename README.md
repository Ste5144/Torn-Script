# Torn-Script

Tampermonkey userscripts for Torn City (torn.com). All scripts are display-only: they never click, submit or change anything in the game. Where a script uses the Torn API it reads only data your own key allows, and the key is stored in Tampermonkey on your browser, never in this repository.

## Scripts

| Script | Runs on | API key | Install |
|---|---|---|---|
| Archer Mining Co Advisor | Company page (`companies.php`) | Limited | [Install](https://raw.githubusercontent.com/Ste5144/Torn-Script/main/archer-mining-advisor.user.js) |

## Installing

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Click the script's **Install** link above. Tampermonkey opens an install page; press **Install**.
3. Updates arrive automatically. Tampermonkey checks once a day; to check now, open the Tampermonkey dashboard and choose **Check for userscript updates**.

If you installed a script before it was on GitHub, remove the old copy first so you do not run two versions.

## Archer Mining Co Advisor

A panel on the company page (green **AMC advisor** button, bottom right) with four tabs:

- **Allocation**: total effectiveness (EE) of every employee in every Mining Corporation role, the same figures TornStats shows. Fills Sales Executive and Secretary first, as these are the roles that earn; support roles need 90+ working-stats EE; Mill Operator takes the rest. Site Manager and Safety Inspector are locked by default. Suggested moves are grouped into changes that can be made on their own.
- **Staff health**: EE breakdown (working stats, settled-in, merits, education, management, addiction, inactivity), flags, and a 30-day trend built from your daily refreshes.
- **Setup**: Torn's income and stock figures, a best-guess demand model for ads, Mill Operator count and price, a daily log, and the role structure of the top mines.
- **Settings**: Limited API key, role weights and locks, minimum gain, and model values.

Make role changes in small steps and check the next day's income before making more.

## Versions

| Version | Date | Change |
|---|---|---|
| 2.0.1 | 7 Nov 2026 | Moved to GitHub with automatic updates. |
| 2.0.0 | 7 Nov 2026 | Allocation scores total EE and fills Sales Executive and Secretary first. |
| 1.x | 6 Nov 2026 | First versions (working-stats allocation; superseded). |
