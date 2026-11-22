# Torn-Script

Tampermonkey userscripts for Torn City (torn.com). All scripts are display-only: they never click, submit or change anything in the game. Where a script uses the Torn API it reads only data your own key allows, and the key is stored in Tampermonkey on your browser, never in this repository.

## Scripts

| Script | Runs on | API key | Install |
|---|---|---|---|
| Archer Mining Co Advisor | Company page (`companies.php`) | Limited | [Install](https://raw.githubusercontent.com/Ste5144/Torn-Script/main/archer-mining-advisor.user.js) |
| Flip Tracker | Item Market and Stock Market | Public | [Install](https://raw.githubusercontent.com/Ste5144/Torn-Script/main/torn-flip-tracker.user.js) |
| Stock Payout Calculator | Stock Market | Limited (reads your holdings; Public works with a fixed list) | [Install](https://raw.githubusercontent.com/Ste5144/Torn-Script/main/torn-stock-payout-calc.user.js) |
| Archer Console | Any Torn page; badges on the Auction House | Public | [Install](https://raw.githubusercontent.com/Ste5144/Torn-Script/main/archer-console.user.js) |
| Mission Mod Checker | Missions page (`page.php?sid=missions`) | None | [Install](https://raw.githubusercontent.com/Ste5144/Torn-Script/main/torn-mission-mod-checker.user.js) |
| High-Low Helper | Casino High-Low (`page.php?sid=highlow`) | None | [Install](https://raw.githubusercontent.com/Ste5144/Torn-Script/main/torn-highlow-helper.user.js) |
| Quick Mail | Any Torn page with player names | None | [Install](https://raw.githubusercontent.com/Ste5144/Torn-Script/main/torn-quick-mail.user.js) |
| War Board | Faction pages (`factions.php`) | Public (+ FFScouter key) | [Install](https://raw.githubusercontent.com/Ste5144/Torn-Script/main/archer-war-board.user.js) |

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
| 2.2.1 | 19 Nov 2026 | Tonnes made now worked out from the API (stock today − stock yesterday + sold), because Torn reports 0 for it. Runway, Role mix and Results by setup no longer need pasted records to show production. |
| 2.2.0 | 19 Nov 2026 | New **Briefing** tab (opens first): recommended next move from stock runway and the role-mix model (add a Sales Executive at 25+ days of stock, cut one under 10, otherwise hold), verdict on the last setup change after 3 logged days, results grouped by setup, daily cost jumps and staff paid above the wage formula (default 20x highest working stat, set in Settings). Paste Torn's Stock records and Company records to fill in history. |
| 2.1.0 | 19 Nov 2026 | New **Role mix** tab: re-runs the allocation for 3 to 6 Sales Executives and shows tonnes made vs demand, income while stock lasts and steady income. Production now uses Mill Operator EE and the Mine Engineer instead of a flat 920 t per MO; demand rises with Sales Executive EE. Stock runway banner (days to empty or to the 40,000 t cap). New **Trains** tab: who gains most EE per company train. |
| 2.0.3 | 11 Nov 2026 | Only suggests a change if it adds at least 5 EE to Sales Executive + Secretary (minimum gain 50 weighted); smaller gains are within estimate error. |
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
| 1.2.3 | 19 Nov 2026 | Backup block list matches holdings at 19 Nov (TMI, PTS, MCS, CBD, THS, TCT added). |
| 1.2.2 | 8 Nov 2026 | Version number shown in the panel title and button tooltip. |
| 1.2.1 | 8 Nov 2026 | Amounts show b for billions and m for millions. |
| 1.2.0 | 8 Nov 2026 | Funding table uses the holdings the Stock Payout Calculator detected. |
| 1.1.4 | 8 Nov 2026 | PTS removed (sold). |
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
- Click a column heading to sort. Untick a row to hide it and leave it out of the totals; **Show hidden** brings unticked rows back so you can tick them again; **Tick all** and **Untick all** reset the selection. With a Limited key it reads your holdings and builds the block list itself; with a Public key it uses the fixed `BLOCKS` list at the top of the script. The Flip Tracker's funding table uses the same detected holdings.

| Version | Date | Change |
|---|---|---|
| 1.4.0 | 19 Nov 2026 | Limited key stored in Tampermonkey instead of the page's storage, where other scripts on torn.com could read it (moved automatically; Torn PDA without Tampermonkey storage keeps the old behaviour). Backup block list matches holdings at 19 Nov. |
| 1.3.2 | 8 Nov 2026 | Version number shown in the panel title and button tooltip. |
| 1.3.1 | 8 Nov 2026 | Amounts show b for billions, m for millions, k for thousands. |
| 1.3.0 | 8 Nov 2026 | Detects your holdings from the API with a Limited key (falls back to the fixed list). Hidden rows keyed by block, not row number. |
| 1.2.1 | 8 Nov 2026 | PTS removed (sold). |
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
- **Auction House badges** (`amarket.php`): each listing shows its current bid against comparable sales. A grade needs at least 5 comparable sales and is only given in the auction's last hour; earlier, the badge shows how high to bid. Great and Good listings get a green outline. Badge colours: solid = graded in the last hour; dashed teal/blue/amber/red = not ending yet, coloured by where the current bid sits (great-buy range, below fair, above fair, over ceiling); purple = too few comparable sales; grey = no history. Live auction stats are read from the page because the API does not serve live auctions. A profit line shows what the item is worth to resell (comparable sales less a resale fee, default 5%) and to trade in for Bunker Bucks, the profit at the current bid, and the max bid for your wanted margin (default 10%); a gold outline marks auctions currently under either max bid.

| Version | Date | Change |
|---|---|---|
| 1.9.0 | 22 Nov 2026 | Auction page loads history by itself: on first sight of an item it pulls 5 pages of sales, then tops up at most once an hour per item, and the boxes update without clicking. Boxes say "Loading auction history…" while it runs, ask for the Public key if none is set, and show the API error if a fetch fails. |
| 1.8.1 | 22 Nov 2026 | Armour auctions read from the page now use the armour value (not damage), drop the weapon index and get the armour Bunker value (12 BB). Previously this only worked when the API supplied the listing. |
| 1.8.0 | 22 Nov 2026 | Green (Great/Good) badges now also need the price to meet your profit wanted (default 10%) on resale or Bunker trade-in. Below fair but short of the margin shows amber, labelled "Great/Good vs fair, but under your 10% profit". Settings tick box "Green only when price meets profit wanted" (on by default) switches back to the old grading. |
| 1.7.0 | 14 Nov 2026 | Auction badges add a profit check: resale value (median or lower-quarter comparable sale, less resale fee) and Bunker Buck trade-in value, profit at the current bid, and the max bid for your wanted margin (default 10%). Auctions currently under either max bid get a gold outline. Settings: resale fee, profit wanted, resale price basis. |
| 1.6.0 | 8 Nov 2026 | Big Al's Bunker trade-in floor: Bunker Bucks per item (type, colour, one or two bonuses) × best cache value per BB from live item market prices after fee. Shown on Auction House badges, Item market, Import live and Ceiling bid; bids or listings under the floor are flagged. Settings: Bunker unlocked, market fee, cache prices. |
| 1.5.0 | 8 Nov 2026 | Import live keeps a saved list: pastes merge (duplicates replaced), end times become countdowns, ended auctions drop off; current bids seen on the Auction House fill the Bid column so saved rows get a deal grade. |
| 1.4.3 | 8 Nov 2026 | Auction badges coloured again: dashed colours for auctions not ending yet (by where the current bid sits), purple for too little history; solid colours and green outline still only in the last hour. |
| 1.4.2 | 8 Nov 2026 | Bonus tier tags judge each bonus by its own roll, not the weapon's colour (a second bonus on an orange weapon can be a yellow roll). |
| 1.4.1 | 8 Nov 2026 | Moved to GitHub with automatic updates. |
| 1.4.0 | 8 Nov 2026 | Auction badges need 5 comparable sales and only grade in the last hour; badge text no longer misread as listing data. |
| 1.3.x | 8 Nov 2026 | mug's guide damage rule and bonus tier tags; price bands from all comparables equally; bonus % read correctly from the page. |
| 1.3.0 | 8 Nov 2026 | Detects your holdings from the API with a Limited key (falls back to the fixed list). Hidden rows keyed by block, not row number. |
| 1.2.1 | 8 Nov 2026 | PTS removed (sold). |
| 1.2.0 | 8 Nov 2026 | Auction House badges. |
| 1.1.x | 8 Nov 2026 | Item market deal grades; text contrast fixed. |
| 1.0.0 | 8 Nov 2026 | First version. |

## Mission Mod Checker

Badges each weapon mod reward on the missions page with a grade against known credit ranges (special-offer and normal price), whether it fits your weapon types, its bonus, and the cash value of the credits at the page's median credit value. A panel (top right) has a manual checker and settings.

| Version | Date | Change |
|---|---|---|
| 1.0.4 | 14 Nov 2026 | Recognises Torn's names "Extra Magazine" (sheet: Extra Clip), "Extended/High Capacity Magazine"; no longer reads its own badge text, which caused wrong names (e.g. Extra Magazine shown as Adjustable Trigger). |
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

## Quick Mail

Adds a small mail icon (✉) after player names across Torn. Clicking it opens Torn's compose page for that player in a new tab and fills in the subject and message set at the top of the script (`SUBJECT`, `IMAGE_URL`, `FOOTER`). You check it and press **Send** yourself; the script never sends or clicks anything. Composing a mail any other way is left untouched.

- **Grey** icon: not mailed from this browser. **Green**: mailed before; hover for the date.
- **Shift+click** an icon to clear that player's mailed mark.
- The mailed log is stored in your browser only, so it doesn't carry across devices.
- Icons are skipped in chat and on avatar pictures; names shown as honor bars get an icon.

| Version | Date | Change |
|---|---|---|
| 1.1.1 | 17 Nov 2026 | Recruitment image now hosted in this repo (`images/`) instead of Imgur, which is blocked in some countries. |
| 1.1.0 | 16 Nov 2026 | Pre-fills the subject and message (recruitment image) when you open compose from the icon. Falls back to copy buttons if the fields can't be found. |
| 1.0.1 | 16 Nov 2026 | Icons also show on names drawn as honor bar images; avatars still skipped. |
| 1.0.0 | 16 Nov 2026 | First version. |

## War Board

A floating panel on faction pages listing the enemy faction's members, with live hospital countdowns. Enemies already out are shown first, then everyone in hospital in order of who comes out soonest. Each row has a red **Attack** button that opens that player's attack page (opens in a new tab; same tab is an option in ⚙).

- **📢 Next 3 to chat** builds one message with the next targets, their release time (countdown and TCT clock time) and attack links. Click into faction chat first and the message is placed in the chat box; you press **Enter** yourself. If the chat box can't be found, the message is copied so you can paste it.
- **⚙ settings:** Public API key, enemy faction ID (leave blank and it uses your faction's current ranked war opponent from the API; type an ID to override), targets per message, an "only out within N minutes" filter, and whether to list enemies already out.
- Countdowns also replace the **Hospital** text in the page's own member list (faction profile and war pages) for the enemy faction. Turn this off in ⚙ if another script already does it.
- Countdowns turn orange in the last two minutes.
- **FFScouter estimates:** each target shows a fair-fight badge (green up to 2.5, amber up to 3.5, red above) and an estimated battle-stat total, from [FFScouter](https://ffscouter.com)'s free API. Needs a Torn key you have registered at ffscouter.com (the one you use for FF Scouter V2): put it in ⚙ under **FFScouter key**, or leave that blank if your War Board API key is the registered one. One bulk request every 5 minutes, or when new enemies appear. Fair fight is relative to you, so the chat message shares the stat estimate, not your FF.
- **⇅** re-orders the page's own enemy list by hospital time: enemies already out first, then soonest out, then travelling/jailed. Click again to go back to Torn's order. The button turns green while sorting is on.
- **Online dot** before each name: green online, yellow idle, grey offline (hover for last action). Also added to the chat message.
- **★ Watch list:** click the star next to a target. You get a beep, a browser notification and an on-screen notice when they are about to come out (10 s before by default) or are released early.
- **Chain bar:** shows your faction's chain count and timer. Below 60 s (adjustable) it flashes, beeps and offers the best target that is out right now.
- **Hide hard targets:** option in ⚙ to hide anyone above fair fight 3.5.
- **Travelling / abroad** list under the targets, with destination and, if the script saw them leave, the time they left.
- **Called targets:** targets you have posted to chat are dimmed with 📢 and skipped by the next post for 3 minutes (adjustable), or until they are hit again.
- **▲ fewer / more ▼** under the list changes how many targets show before scrolling (3 at a time); set an exact number in ⚙.
- **Drag** the title bar to move the panel; it remembers its position. Double-click the title bar to reset it to the bottom right.
- Refreshes from the API every 15 seconds while the panel is open, and early (at most every 4 seconds) when the page's live status changes or a timer runs out. If the page shows an enemy back in hospital before the API has the new time, they show as **Hosp…** rather than OUT.

- **Stat estimate in chat** is on by default and can be turned off in ⚙. FFScouter states that estimates from its free API may be used and shared by anyone, free of charge.
- **One caller per war works best.** The "called" list is kept on your own screen only, so if several people post, they may post the same targets. Agree in the faction who posts.
- Built for desktop browsers with Tampermonkey; Torn PDA on mobile may not support everything it uses.

### Data and API key

| | |
|---|---|
| Key access level | **Public** is all War Board needs from Torn. For FFScouter, use the key you registered there (FFScouter recommends a Custom key). |
| Key storage | Saved in Tampermonkey in your own browser, never in this repository. The Torn API key is sent only to `api.torn.com`; the FFScouter key only to `ffscouter.com`. |
| Data read | Your faction's current ranked war and chain; the enemy faction's member list (names, levels, status, hospital times, last action). |
| Data stored | Your settings, starred players and panel position, in Tampermonkey on your browser. Nothing is stored on any server. |
| Data shared | With FFScouter estimates on (default): your FFScouter key and the enemy player IDs are sent to ffscouter.com to get estimates; turn **FFScouter estimates** off in ⚙ to stop this. Nothing else is sent anywhere. The chat message is only what you choose to post. |
| Purpose | Showing hospital timers and helping you pick and call targets during wars. |

| Version | Date | Change |
|---|---|---|
| 2.0 | 21 Nov 2026 | Switched from BSP to **FFScouter**: fair-fight badge and stat estimate from FFScouter's API; hide-above-FF-3.5 option; stat estimate in chat. BSP reading and the "your battle stats" setting removed. |
| 1.11 | 20 Nov 2026 | Ready to share: BSP figures left out of the chat message unless you turn them on; BSP cache lookup limited to BSP's own entries; README lists what data and API access the script uses. |
| 1.10 | 20 Nov 2026 | Choose how many targets show before scrolling: ▲ fewer / more ▼ buttons under the list, or a number in ⚙ (0 = fit the screen). Default 12. |
| 1.9 | 20 Nov 2026 | Compact one-line rows (about three times as many targets visible), green edge on targets that are out, gold tint on ★ targets, travellers list collapsed behind a click. |
| 1.8 | 20 Nov 2026 | Online dots, ★ watch list alerts, chain timer warning, BSP colours against your stats, travellers list, and skipping of already-called targets. |
| 1.7 | 20 Nov 2026 | No more false OUT: watches the page's live status column, marks re-hospitalised enemies straight away and refreshes early; refresh every 15 s; refresh when a timer runs out. |
| 1.6.2 | 20 Nov 2026 | Attack button opens in a new tab by default, keeping the war page open. |
| 1.6.1 | 20 Nov 2026 | Attack links use Torn's new address (`page.php?sid=attack`); the old `loader.php` one now returns an error. |
| 1.6 | 20 Nov 2026 | Shows each target's BSP figure (from your BSP script) in the panel and the chat message. ⇅ button sorts the page's enemy list by hospital time. |
| 1.5 | 20 Nov 2026 | Neater chat message: numbered, one target per line with the attack link underneath, TCT release time first. Single-line layout available in ⚙. |
| 1.4 | 20 Nov 2026 | Attack button now works reliably: the list no longer redraws every second (only the timers update), so clicks aren't lost. Bigger red Attack button; opens in the same tab unless set otherwise. |
| 1.3 | 20 Nov 2026 | Countdowns now appear in the ranked war member list. Enemy faction taken from your current ranked war via the API (page guessing removed; it could pick a territory-war faction). Clears any previously saved enemy ID once. |
| 1.2 | 20 Nov 2026 | Countdowns shown in the page's own Hospital status cells, not just the panel. |
| 1.1 | 20 Nov 2026 | Panel can be dragged and remembers its position; notices follow the panel. |
| 1.0 | 20 Nov 2026 | First version. |
