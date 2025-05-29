import puppeteer from 'puppeteer';
import dotenv from 'dotenv';

dotenv.config();
const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
const userId = process.env.LINE_USER_ID


async function getGymStatus() {
  const today = new Date();
  const year = today.getFullYear();
  const month = (today.getMonth() + 1).toString().padStart(2, '0');
  const day = today.getDate().toString().padStart(2, '0');
  const date = `${year}${month}${day}`;
  const selectedFacility = ["パークアリーナ小牧", "大輪体育館"]
  const selectedPlaces = ["メインアリーナ", "サブアリーナ", "競技場"]
  const selectedArea = [{
    facility: "パークアリーナ小牧",
    place: "メインアリーナ",
    area: ["全面", "２／３", "１／３"]
  }, 
  {
    facility: "パークアリーナ小牧",
    place: "サブアリーナ",
    area: ["全面", "半面"]
  }, 
  {
    facility: "大輪体育館",
    place: "競技場",
    area: ["全面"]
  }]
  // chromeを起動する
  const browser = await puppeteer.launch({
    headless: true, // ブラウザを表示する
    channel: 'chrome',
    args: [
      '--disable-blink-features=AutomationControlled', // ←検出回避のため
      '--start-maximized' // ←ウィンドウを最大化
    ],
    defaultViewport: null
  });
  
  const page = await browser.newPage();
  await page.goto("https://www.pf489.com/komaki/WebR/Home/WgR_ModeSelect", {
      waitUntil: ["load", "networkidle0"],
  });
  // 「スポーツ施設（予約・抽選）」を選択
  await page.click("#category_10");
  await page.waitForNavigation({ waitUntil: 'networkidle2' });
  // 施設選択
  await page.evaluate((selectedFacility) => {
    const allFacilities = Array.from(document.querySelectorAll('tbody#shisetsutbl tr td.shisetsu'))
    // console.log(allFacilities)
    for (const f of allFacilities) {
      if (selectedFacility.some(facility => f.innerText.includes(facility))) {
        f.querySelector('input').click();
      }
    }
  }, selectedFacility);
  await new Promise(resolve => setTimeout(resolve, 1000)); // 1秒待つ
  await page.click('#btnNext');
  await page.waitForNavigation({ waitUntil: ['networkidle2', 'load'] });

  // 日付選択
  await page.evaluate((date, selectedPlaces) => {
    const getPlaces = Array.from(document.querySelectorAll('div.item_body div.item tbody tr'))
    for (const p of getPlaces){
      if (selectedPlaces.some(place => p.innerText.includes(place))){
        const inputTags = Array.from(p.querySelectorAll('input[type="checkbox"]'))
        for (const inputTag of inputTags) {
          if (inputTag.value.includes(date)){
            inputTag.click();
          }
        }
      }
    }
  }, date, selectedPlaces);
  await new Promise(resolve => setTimeout(resolve, 1000)); // 1秒待つ
  await page.click('li.next a.btnBlue');
  await page.waitForNavigation({ waitUntil: ['networkidle2', 'load'] });

  // 空き状況一覧ページをスクレイピング
  const returnGymTables = await page.evaluate((selectedArea) => {
    const facilityTables = Array.from(document.querySelectorAll("div.item_body div.item"))
    const gymTables = facilityTables.map(item => {
      const facility = item.querySelector("h3").innerText.trim().split(/\s|　/)[0];
      const places = Array.from(item.querySelectorAll("h4"));
      const statusTables = item.querySelectorAll("div.scroll-div");
      // console.log(statusTables)
      const placeStatusTables = places.map((place, index) => {
        const reservasionTimesTable = Array.from(statusTables[index].querySelectorAll("thead th"));
        const reservationTimes = reservasionTimesTable.map(th => {
          if (th.innerText.includes("～")) {
            return th.innerText.replace(/\n/g, '').trim();
          }
          return null;
        }).filter(time => time !== null);
        const allArea = Array.from(statusTables[index].querySelectorAll("tbody tr"));
        const validStatus = allArea.map(tr => {
          const areaName = tr.querySelector("td.shisetsu").innerText
          if (selectedArea.some(a =>
            a.facility === facility && 
            a.place === place.innerText.replace(/【.*$/, '') && 
            a.area.some(ar => areaName.includes(ar))
          )) {
            const eachTimeStatus = tr.querySelectorAll("td.readonly");
            const timeStatus = Array.from(eachTimeStatus).map(td => {
              return td.innerText;
            })
            return {
              areaName: areaName,
              validStatusList: timeStatus
            }
          }
          return null;
        })
        return {
          place: place.innerText.replace(/【.*$/, ''),
          reservationTimes: reservationTimes,
          placeStatusTable: validStatus.filter(status => status !== null),
        }
      })
      return {
        facility: facility,
        tables: placeStatusTables
      }
    })
    console.log(gymTables)
    return gymTables;
  }, selectedArea);
  await browser.close();

  for (const gymTable of returnGymTables) {
    const gymName = gymTable.facility
    await sendMessage(`${gymName}の空き状況をお知らせします。`);
    for (const placeTable of gymTable.tables) {
      const message = [];
      message.push(`${placeTable.place}⛹️‍♂️`);
      placeTable.placeStatusTable.forEach(areaStatus => {
        message.push(`【${areaStatus.areaName}】`);
        let flag = false;
        areaStatus.validStatusList.forEach((status, index) => {
          if (status == "○") {
            message.push(placeTable.reservationTimes[index]);
            flag = true;
          }
        });
        if (!flag){
          message.push("本日は空いていません");
        }
      })
      // console.log(message);
      try {
        await sendMessage(message.join("\n"));
      }
      catch (err) {
        console.error("Error sending message:", err);
      }
    }
  }
}

async function sendMessage(message) {
    await fetch ("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
        }, 
        body: JSON.stringify({
            to: userId,
            messages: [
              {
                type: "text",
                text: message,
              },
            ],
        }),
    });
}


getGymStatus()
  .then(() => {
    console.log("メッセージの送信まで成功しました");
  })
  .catch((error) => {
    console.error("途中でエラーが発生しました:", error);
  });
