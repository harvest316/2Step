# Personalised Video Landing Page -- Sales Copy

> This copy is for the page sent to cold prospects via the 2Step outreach pipeline.
> The recipient did NOT ask for this. We found their business, made a free 30-second
> video from their best Google review, and sent them a link. The page hosts the video
> and sells the subscription.
>
> Two spintax variants per section for A/B testing. Variables in [brackets].

---

## 1. Above-the-fold hook

One line above the video player. No "we". About THEM.

**Variant A:**
> [business_name] -- [star_rating] stars, [review_count] reviews, and now a video that shows it.

**Variant B:**
> Your best Google review just got a lot harder to ignore, [business_name].

---

## 2. Below-video nudge

Two lines max. Sits directly under the video player. Acknowledge the free gift, create curiosity.

**Variant A:**
> That video is yours. Free. Use it on your socials, your website, wherever you want.
> Imagine what four or eight of these a month would do for [business_name].

**Variant B:**
> This one's on the house -- share it, post it, it's yours.
> Most [niche] businesses in [city] don't have anything like this. You could.

---

## 3. Social proof / stats block

Three short bullets. Grounded in real, defensible data.

**Variant A:**
> - 88% of people say a branded video convinced them to buy a product or service.
> - Listings with photos and video get 42% more direction requests on Google.
> - Short-form video gets 2.5x more engagement than any other content format.

**Variant B:**
> - 87% of customers have bought something after watching a business's video.
> - Google Business Profiles with visual content surface 80% more often in search.
> - Videos under 60 seconds hold 50% average engagement -- text posts don't come close.

---

## 4. "How it works" section

Three steps, max 8 words each.

**Variant A:**
> 1. We pick your best Google reviews.
> 2. Turn them into short videos.
> 3. You post. Customers call.

**Variant B:**
> 1. Your top reviews become video scripts.
> 2. We produce and deliver each month.
> 3. Share them anywhere. Get more calls.

---

## 5. Pricing intro

Two lines framing the price. Reference competitor range.

**Variant A:**
> Video agencies charge [symbol]500 to [symbol]5,000 a month. Social media managers aren't much cheaper.
> We start at [symbol][price4]/mo for 4 videos -- less than a single job lead in most [niche] businesses.

**Variant B:**
> Hiring someone to make even one decent video would cost you more than this.
> Starting at [symbol][price4]/mo for 4 professional videos. No lock-in. Cancel whenever.

---

## 6. FAQ section

Four questions a sceptical tradie would ask.

### Q1: Did I ask for this?

**Variant A:**
> Nope. We found [business_name] through your Google reviews and thought your [star_rating]-star reputation deserved more than just text on a screen. The video is genuinely free -- no invoice coming, no weird catch.

**Variant B:**
> No, and that's kind of the point. We spotted [business_name]'s reviews, thought they were too good to just sit there as text, and made you a video to prove what we can do. It costs you nothing.

### Q2: What do I actually get if I sign up?

**Variant A:**
> Each month we pick your strongest new Google reviews, turn them into professional short videos with voiceover and music, and deliver them ready to post on Instagram, Facebook, your website, or your Google listing. You just approve and share.

**Variant B:**
> Fresh videos every month, built from your real customer reviews. Voiceover, music, branded -- ready to drop straight onto your socials or website. We handle production. You hit publish.

### Q3: Can I cancel anytime?

**Variant A:**
> Yes. Monthly billing, no contracts, no lock-in. If it's not working for you, cancel and that's it.

**Variant B:**
> Absolutely. Month to month. No minimum term, no exit fees. Cancel from your dashboard whenever you want.

### Q4: I don't really do social media -- is this still useful?

**Variant A:**
> These videos work just as well embedded on your website or added to your Google Business Profile. You don't need to be a social media person. Most of our [niche] clients just post them and move on -- takes about 30 seconds.

**Variant B:**
> Plenty of our clients don't either. You can stick the video on your Google listing, your website, or just send the link to customers who ask what you're about. No hashtags required.

---

## 7. Final CTA

One line. Conversational. Low pressure.

**Variant A:**
> If you liked the free one, hit the button and we'll sort out the rest.

**Variant B:**
> Keen? Pick a plan below and your first batch starts this week.

---

## 8. "What's the catch?" objection handler

Three sentences max. Why the video is free.

**Variant A:**
> There's no catch. We make free videos for businesses with great Google reviews because it's the fastest way to show you what we do. If you like it, brilliant -- if not, the video is still yours to keep.

**Variant B:**
> Honestly, the free video is our pitch. Instead of sending you a boring email about what we could do, we just did it. You keep the video either way -- no follow-up spam, no obligation.

---

## Implementation notes

- Variables: `[business_name]`, `[niche]`, `[city]`, `[review_count]`, `[star_rating]`, `[review_author]`, `[symbol]`, `[price4]`, `[price8]`, `[price12]`
- Australian pricing: A$139 / A$249 / A$349 per month (4/8/12 videos)
- Setup fee: $0 (waived per DR-082)
- Competitor range pulled from `getCompetitorPriceRange()` in pricing.php
- All stats sourced from HubSpot 2026, Wyzowl 2025, and Google/BrightLocal data
- Spelling: Australian English throughout (recognise, colour, sceptical, etc.)
- Tone calibration: matches AU sequence.json voice -- casual, direct, no jargon
