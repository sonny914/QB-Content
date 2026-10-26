# The 8 AM Weather Bot

*One trigger, one action. About 20 minutes. No code.*

**What you're building:** every morning at 8 a.m., your phone gets a Telegram message with today's high and the chance of rain. You never touch it.

**You need:**
- Telegram on your phone
- An n8n account ([n8n.io](https://n8n.io)). Use the Cloud version so it keeps running when your laptop is closed. It's paid after the free trial, so check the current pricing.

---

## Step 1: Make your bot (3 min)

1. In Telegram, search **@BotFather**. Pick the one with the blue checkmark.
2. Send `/newbot`.
3. Give it a name, then a username ending in `bot` (e.g. `mymorning_bot`).
4. BotFather replies with your **token**. It looks like `7123456789:AAHk3x9...`.

> **Lost the token?** Message BotFather `/mybots`, tap your bot, then tap **API Token**.
>
> **Keep it private.** Anyone with your token controls your bot. Blur it in screenshots. If it leaks, use **Revoke current token** on that same screen.

## Step 2: Get your Chat ID (2 min)

1. **Open your new bot (not BotFather), tap Start, and send it "hi".**
   Skip this and nothing works, because a bot can't message you until you've messaged it.
2. In your browser, open:
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
   Replace `<YOUR_TOKEN>` with your token, and keep the word `bot` in front of it.
3. Find `"chat":{"id":` and copy the number after it. That's your **Chat ID**.

> **Two different numbers. Don't swap them:**
> - **Token** has a colon: `7123456789:AAHk3x9...` → goes in the **credential**
> - **Chat ID** is just digits: `583920471` → goes in the node's **Chat ID** field
>
> **Page shows `"result":[]`?** Send your bot another message and refresh.

## Step 3: The trigger, 8 AM daily (2 min)

1. In n8n, create a new workflow.
2. Add a **Schedule Trigger**: every **Day**, hour **8**, minute **0**.
3. Open the workflow's **Settings** and set **Timezone** to your city (e.g. America/New_York). If you skip this, it fires at 8 a.m. on the server's clock.

## Step 4: Get the forecast (3 min)

1. Add an **HTTP Request** node. Method: **GET**.
2. URL (this one is for New York; swap in your city's latitude, longitude and timezone):
   ```
   https://api.open-meteo.com/v1/forecast?latitude=40.71&longitude=-74.01&daily=temperature_2m_max,precipitation_probability_max&temperature_unit=fahrenheit&timezone=America%2FNew_York&forecast_days=1
   ```
3. Click **Test step**. You should see `temperature_2m_max` and `precipitation_probability_max` in the output.

Open-Meteo is free with no API key for personal, non-commercial use.

## Step 5: Send it to your phone (5 min)

1. Add a **Telegram** node and choose **Send a text message**.
2. **Credential to connect with → Create new credential.** Paste your **token** into **Access Token** and save. You should see "Connection tested successfully."
3. **Chat ID:** paste your Chat ID.
4. **Text:** switch the field to **Expression** and paste:
   ```
   Good morning.
   High {{ $json.daily.temperature_2m_max[0] }}°F · {{ $json.daily.precipitation_probability_max[0] }}% chance of rain
   ```
5. **Add Field → Append n8n Attribution → off.** This removes the "sent with n8n" footer.
6. Click **Test step**. Your phone should buzz.

## Step 6: Publish it

Click **Publish** (top right). **Save** only keeps a draft, and nothing runs on schedule until you publish.
If you edit the workflow later, publish again.

Then leave it alone for three mornings. If a message doesn't show up, open the **Executions** tab. It shows whether it ran and where it stopped.

---

## If it breaks

| Error | Fix |
|---|---|
| **Chat not found** | Send your bot "hi", then get the Chat ID again from `getUpdates`. Make sure it's your chat with your bot, not BotFather. |
| **Bad request: please check your parameters** | Open the error **Details**. It's usually "chat not found" (above) or an empty message (below). |
| **Unauthorized** | Wrong token. Get it again with `/mybots` → your bot → **API Token**. |
| **Message is empty / says `undefined`** | The expression can't find the data. Run the HTTP Request step first and check the field names match. |
| **Nothing arrived at 8 AM** | Did you click **Publish**? Is the timezone set? Check **Executions**. |

---

## Stack the next one

Add an **IF** node between the forecast and Telegram that only lets the message through when rain is above 50%. Then it's no longer a daily report. It's an alert that only messages you when it matters.
