# Torn-Script

Tampermonkey userscripts for Torn City (torn.com). All scripts are display-only: they never click, submit or change anything in the game. Where a script uses the Torn API it reads only data your own key allows, and the key is stored in Tampermonkey on your browser, never in this repository.

## Scripts

| Script | Runs on | API key | Install |
|---|---|---|---|
| Archer Mining Co Advisor | Company page (`companies.php`) | Limited | [Install](https://raw.githubusercontent.com/Ste5144/Torn-Script/main/archer-mining-advisor.user.js) |
| Flip Tracker | Item Market and Stock Market | Public | [Install](https://raw.githubusercontent.com/Ste5144/Torn-Script/main/torn-flip-tracker.user.js) |
| Stock Payout Calculator | Stock Market | Public | [Install](https://raw.githubusercontent.com/Ste5144/Torn-Script/main/torn-stock-payout-calc.user.js) |
| Archer Console | Any Torn page; badges on the Auction House | Public | [Install](https://raw.githubusercontent.com/Ste5144/Torn-Script/main/archer-console.user.js) |
| Mission Mod Checker | Missions page (`page.php?sid=missions`) | None | [Install](https://raw.githubusercontent.com/Ste5144/Torn-Script/main/torn-mission-mod-checker.user.js) |
| High-Low Helper | Casino High-Low (`page.php?sid=highlow`) | None | [Install](https://raw.githubusercontent.com/Ste5144/Torn-Script/main/torn-highlow-helper.user.js) |

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
| 1.1.3 | 8 Nov 2026 | Funding table matches holdings at 8 Nov (HRG added, sold blocks removed). |
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
| 1.2.0 | 8 Nov 2026 | Blocks match holdings at 8 Nov (HRG added, sold blocks removed); $/property input for HRG. Hidden-row ticks reset. |
| 1.1.0 | 7 Nov 2026 | Unticked rows hide; Show hidden, Tick all and Untick all. |
| 1.0.1 | 7 Nov 2026 | First version, on GitHub with automatic updates. |

## Archer Console

A weapon and auction dashboard (purple **Archer Console** button, bottom left, or Alt+A) on any Torn page. Uses only the official Torn API with a Public key; nothing is sent anywhere else. Works in Torn PDA.

- **Auction history**: completed auction sales (`market/{id}/auctionhouse`), cached in your browser, with Swervelord-style filters and summary prices.
- **Ceiling bid**: enter an item's stats; the 15 closest past sales (same item and main bonus, weighted by bonus %, damage, accuracy, rarity and age) give Great (lower quarter), Fair (median) and Ceiling (upper quarter).
- **Import live**: paste rows from the Swervelord live floor; they are saved and merged with earlier pastes until each auction ends, ranked by index with fair and ceiling prices. Bids seen on Torn's Auction House page fill in the Bid column and a deal grade.
- **Item market**: live listings by weapon and bonus, value per dollar, a star for listings nothing else beats, and a Deal grade against auction history (Deals only filter).
- **Ranking**: Index = 100 × damage factor × bonus multiplier (100 = a 70-damage weapon with no damage bonus). Damage compounds about 2.3% per point (mug's guide: 10 points ≈ 25%). Armour assumed to absorb 50% (guide: about 1% per armour point). Bonus tags show mug's damage tier and whether the roll is low or high for its colour.
- **Mods**: weapon mod credit ranges with a price checker.
- **Bunker floor**: what a ranked-war item is worth traded in at Big Al's Bunker. Bunker Bucks (rifle/shotgun 10, pistol/SMG 4, melee 6, MG/HA 14, armour 12; ×3 orange, ×4.5 orange with two bonuses, ×9 red, ×13.5 red with two) × the best cache price per Bunker Buck on the item market, after the market fee. Listings and bids below it are flagged.
- **Auction House badges** (`amarket.php`): each listing shows its current bid against comparable sales. A grade needs at least 5 comparable sales and is only given in the auction's last hour; earlier, the badge shows how high to bid. Great and Good listings get a green outline. Badge colours: solid = graded in the last hour; dashed teal/blue/amber/red = not ending yet, coloured by where the current bid sits (great-buy range, below fair, above fair, over ceiling); purple = too few comparable sales; grey = no history. Live auction stats are read from the page because the API does not serve live auctions.

| Version | Date | Change |
|---|---|---|
| 1.6.0 | 8 Nov 2026 | Big Al's Bunker trade-in floor: Bunker Bucks per item (type, colour, one or two bonuses) × best cache value per BB from live item market prices after fee. Shown on Auction House badges, Item market, Import live and Ceiling bid; bids or listings under the floor are flagged. Settings: Bunker unlocked, market fee, cache prices. |
| 1.5.0 | 8 Nov 2026 | Import live keeps a saved list: pastes merge (duplicates replaced), end times become countdowns, ended auctions drop off; current bids seen on the Auction House fill the Bid column so saved rows get a deal grade. |
| 1.4.3 | 8 Nov 2026 | Auction badges coloured again: dashed colours for auctions not ending yet (by where the current bid sits), purple for too little history; solid colours and green outline still only in the last hour. |
| 1.4.2 | 8 Nov 2026 | Bonus tier tags judge each bonus by its own roll, not the weapon's colour (a second bonus on an orange weapon can be a yellow roll). |
| 1.4.1 | 8 Nov 2026 | Moved to GitHub with automatic updates. |
| 1.4.0 | 8 Nov 2026 | Auction badges need 5 comparable sales and only grade in the last hour; badge text no longer misread as listing data. |
| 1.3.x | 8 Nov 2026 | mug's guide damage rule and bonus tier tags; price bands from all comparables equally; bonus % read correctly from the page. |
| 1.2.0 | 8 Nov 2026 | Auction House badges. |
| 1.1.x | 8 Nov 2026 | Item market deal grades; text contrast fixed. |
| 1.0.0 | 8 Nov 2026 | First version. |

## Mission Mod Checker

Badges each weapon mod reward on the missions page with a grade against known credit ranges (special-offer and normal price), whether it fits your weapon types, its bonus, and the cash value of the credits at the page's median credit value. A panel (top right) has a manual checker and settings.

| Version | Date | Change |
|---|---|---|
| 1.0.3 | 8 Nov 2026 | Moved to GitHub with automatic updates. |
| 1.0.2 | 7 Nov 2026 | Runs on `page.php?sid=missions`; panel moved to the top right. |
| 1.0.0 | 7 Nov 2026 | First version. |

## High-Low Helper

A panel on the casino's High-Low page that reads the dealer card and your card as they are dealt and tracks every card out of the deck. It never presses Higher, Lower or Cash In.

- **Guess**: the best pick against the dealer card and its win chance, worked out from the cards still in the deck.
- **Collect or continue**: after a win, the value of carrying on (averaged over every card the next dealer card could be) against banking the pot. At a 25% modifier this is about ×0.90, so it nearly always says collect.
- **Chance modifier**: read from the page's "Current modifier" figure.
- **Outcome log**: every round and game, exported as CSV. A loss or a Cash In is logged automatically, checked against Torn's "wins in a row" count (a draw carries on). The Collected and Took 50% buttons are there as a backup. Enter your bet so each game shows a profit.
- A game in progress survives a page reload or script update (for 30 minutes). **New game** picks up a dealer card already showing.

| Version | Date | Change |
|---|---|---|
| 6.3.0 | 8 Nov 2026 | Wins and losses checked against Torn's own "wins in a row" count, so a missed button press no longer turns a loss into a win. Cash In is logged automatically, with the payout taken from the pot. |
| 6.2.1 | 8 Nov 2026 | A draw no longer ends the game: it is treated as a push and the deck carries on. Ties setting removed. |
| 6.2.0 | 8 Nov 2026 | Moved to GitHub with automatic updates. Game in progress kept across reloads; New game reads the card on the table; chance modifier read from the page. |
| 6.1.0 | 8 Nov 2026 | Reads cards correctly now Torn flips them between two faces (the hidden face can hold the previous card). |
| 6.0.x | 11 Oct 2026 | Automatic card reading; records which button you pressed. |
| 5.x | 11 Oct 2026 | Outcome log and CSV export. |
| 1.0 to 4.0 | 11 Oct 2026 | First versions: odds, deck tracking, collect advice. |
