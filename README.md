# Torn-Script

Tampermonkey userscripts for Torn City (torn.com). All scripts are display-only: they never click, submit or change anything in the game. Where a script uses the Torn API it reads only data your own key allows, and the key is stored in Tampermonkey on your browser, never in this repository.

## Scripts

| Script | Runs on | API key | Install |
|---|---|---|---|
| Archer Mining Co Advisor | Company page (`companies.php`) | Limited | [Install](https://raw.githubusercontent.com/Ste5144/Torn-Script/main/archer-mining-advisor.user.js) |
| Flip Tracker | Item Market and Stock Market | Public | [Install](https://raw.githubusercontent.com/Ste5144/Torn-Script/main/torn-flip-tracker.user.js) |
| Stock Payout Calculator | Stock Market | Public | [Install](https://raw.githubusercontent.com/Ste5144/Torn-Script/main/torn-stock-payout-calc.user.js) |

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

### Versions

| Version | Date | Change |
|---|---|---|
| 2.0.2 | 8 Nov 2026 | Total EE no longer counts the Site Manager's management boost, which only applies to underperformers and was inflating some people's scores in other roles. |
| 2.0.1 | 7 Nov 2026 | Moved to GitHub with automatic updates. |
| 2.0.0 | 7 Nov 2026 | Allocation scores total EE and fills Sales Executive and Secretary first. |
| 1.x | 6 Nov 2026 | First versions (working-stats allocation; superseded). |

## Flip Tracker

A panel on the Item Market and Stock Market pages (green **Flip tracker** button, bottom left) for holding items to sell later:

- **Funding sources**: each stock block you could sell, its live value and yield, and how much an item must rise over your hold period to beat keeping the block (after the 5% market tax and 0.1% stock fee).
- **Watchlist**: lowest item market price and market value, 7-day and 30-day change, 12-month low and high (chart readings plus your own snapshots), a Cheap/Fair/Dear signal, net upside to the pre-crash price and to the 12-month high, and your positions with profit after tax.
- Takes one snapshot a day automatically when a page loads; **Copy CSV** exports the history. Edit `WATCHLIST` and `HISTORY` at the top of the script to change items.

| Version | Date | Change |
|---|---|---|
| 1.1.2 | 7 Nov 2026 | Moved to GitHub with automatic updates. |
| 1.1.1 | 6 Nov 2026 | Rockstar Rudolph and Erotic DVD baselines. |
| 1.1.0 | 6 Nov 2026 | 12-month baselines, signal and upside columns. |
| 1.0.x | 6 Nov 2026 | First version; panel moved left; text contrast fixed. |

## Stock Payout Calculator

A panel on the Stock Market page (blue **Stock payouts** button, bottom left, above the Flip tracker button) that values every benefit block:

- Choose a period from 7 days to 12 months; every figure recalculates.
- Item payouts are valued at the live lowest listing or market value, optionally less the 5% tax. Points use the points market; energy uses the cheapest Red Cow ÷ 25; nerve and happiness use values you set.
- Shows block value, value per payout, payouts in the period, income, yield per year, what the sale money would earn at your chosen alternative return, and a Keep or Sell candidate verdict.
- Click a column heading to sort. Untick a row to hide it and leave it out of the totals; **Show hidden** brings unticked rows back so you can tick them again; **Tick all** and **Untick all** reset the selection. Edit `BLOCKS` at the top of the script if your holdings change.

| Version | Date | Change |
|---|---|---|
| 1.1.0 | 7 Nov 2026 | Unticked rows hide; Show hidden, Tick all and Untick all. |
| 1.0.1 | 7 Nov 2026 | First version, on GitHub with automatic updates. |
