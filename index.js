import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

// Lambda環境ではdotenv不要。環境変数はマネジメントコンソールやSAM/Serverlessで設定
const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const userId = process.env.LINE_USER_ID;
const groupId = process.env.LINE_GROUP_ID;

export const handler = async (event) => {
  try {
    await getGymStatus();
    return {
      statusCode: 200,
      body: JSON.stringify('メッセージ送信成功'),
    };
  } catch (error) {
    console.error("処理全体でエラーが発生しました:", error);
    return {
      statusCode: 500,
      body: JSON.stringify(`エラーが発生しました: ${error.message}`),
    };
  }
};

async function getGymStatus() {
  const today = new Date();
  const year = today.getFullYear();
  const month = (today.getMonth() + 1).toString().padStart(2, '0');
  const day = today.getDate().toString().padStart(2, '0');
  const date = `${year}${month}${day}`;

  const selectedFacility = ["パークアリーナ小牧", "大輪体育館"];
  const selectedPlaces = ["メインアリーナ", "サブアリーナ", "競技場"];
  const selectedArea = [
    { facility: "パークアリーナ小牧", place: "メインアリーナ", area: ["全面", "２／３", "１／３"] },
    { facility: "パークアリーナ小牧", place: "サブアリーナ", area: ["全面", "半面"] },
    { facility: "大輪体育館", place: "競技場", area: ["全面", "１／３"] }
  ];

  let browser = null; // browserをtryの外で宣言

  try {
    // Puppeteerを起動
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport, // defaultViewportもライブラリから取得
      executablePath: await chromium.executablePath(),
      headless: chromium.headless, // ヘッドレスモードを有効化
    });

    const page = await browser.newPage();

    // タイムアウト設定を長めにする (Lambdaのタイムアウトも考慮)
    page.setDefaultNavigationTimeout(60000); // 60秒

    await page.goto("https://www.pf489.com/komaki/WebR/Home/WgR_ModeSelect", {
      waitUntil: ["load", "networkidle0"], // ページ読み込み完了とネットワークアイドル状態を待つ
    });

    console.log("「スポーツ施設（予約・抽選）」を選択します。");
    await page.waitForSelector("#category_10", { timeout: 10000 }); // セレクタの出現を待つ
    await page.click("#category_10");
    await page.waitForSelector('tbody#shisetsutbl', { timeout: 15000 });
    console.log("施設選択ページに遷移しました。");

    // 施設選択
    await page.waitForSelector('tbody#shisetsutbl tr td.shisetsu', { timeout: 10000 });
    await page.evaluate((facilities) => {
      const allFacilities = Array.from(document.querySelectorAll('tbody#shisetsutbl tr td.shisetsu'));
      for (const f of allFacilities) {
        if (facilities.some(facility => f.innerText.includes(facility))) {
          f.querySelector('input').click();
        }
      }
    }, selectedFacility);
    await new Promise(resolve => setTimeout(resolve, 1000)); // 固定待機は避けるのが望ましい
    console.log("施設を選択しました。");

    await page.waitForSelector('#btnNext', { timeout: 10000 });
    await page.click('#btnNext');
    console.log("日付・場所選択ページに遷移しました。");


    // 日付選択
    await page.waitForSelector('div.item_body div.item tbody tr', { timeout: 10000 });
    await page.evaluate((targetDate, places) => {
      const getPlaces = Array.from(document.querySelectorAll('div.item_body div.item tbody tr'));
      for (const p of getPlaces) {
        if (places.some(place => p.innerText.includes(place))) {
          const inputTags = Array.from(p.querySelectorAll('input[type="checkbox"]'));
          for (const inputTag of inputTags) {
            if (inputTag.value.includes(targetDate)) {
              inputTag.click();
            }
          }
        }
      }
    }, date, selectedPlaces);
    await new Promise(resolve => setTimeout(resolve, 1000)); // 固定待機は避けるのが望ましい
    console.log("日付・場所を選択しました。");

    await page.waitForSelector('li.next a.btnBlue', { timeout: 10000 });
    await page.click('li.next a.btnBlue');
    await page.waitForNavigation({ waitUntil: ['networkidle2', 'load'] });
    console.log("空き状況一覧ページに遷移しました。");

    // 空き状況一覧ページをスクレイピング
    // page.evaluate内でconsole.logを使用してもLambdaのログには出力されません。
    // デバッグ時は、evaluateの戻り値として情報を返し、Lambda側でログ出力してください。
    const returnGymTables = await page.evaluate((areas) => {
      const facilityTables = Array.from(document.querySelectorAll("div.item_body div.item"));
      return facilityTables.map(item => {
        const facility = item.querySelector("h3").innerText.trim().split(/\s|　/)[0];
        const placesElements = Array.from(item.querySelectorAll("h4"));
        const statusTablesElements = item.querySelectorAll("div.scroll-div");

        const placeStatusTables = placesElements.map((placeElement, index) => {
          const placeName = placeElement.innerText.replace(/【.*$/, '').trim();
          const reservationTimesTable = Array.from(statusTablesElements[index].querySelectorAll("thead th"));
          const reservationTimes = reservationTimesTable
            .map(th => th.innerText.includes("～") ? th.innerText.replace(/\n/g, '').trim() : null)
            .filter(time => time !== null);

          const allAreaRows = Array.from(statusTablesElements[index].querySelectorAll("tbody tr"));
          const validStatus = allAreaRows.map(tr => {
            const areaNameText = tr.querySelector("td.shisetsu").innerText.trim();
            const selectedAreaConfig = areas.find(a =>
              a.facility === facility &&
              a.place === placeName &&
              a.area.some(ar => areaNameText.includes(ar))
            );

            if (selectedAreaConfig) {
              const eachTimeStatus = Array.from(tr.querySelectorAll("td.readonly")).map(td => td.innerText.trim());
              return {
                areaName: areaNameText,
                validStatusList: eachTimeStatus
              };
            }
            return null;
          }).filter(status => status !== null);

          return {
            place: placeName,
            reservationTimes: reservationTimes,
            placeStatusTable: validStatus,
          };
        });
        return {
          facility: facility,
          tables: placeStatusTables
        };
      });
    }, selectedArea);

    console.log("スクレイピングが完了しました。");

    // メッセージ送信処理
    for (const gymTable of returnGymTables) {
      const gymName = gymTable.facility;
      await sendMessage(`${gymName}の空き状況をお知らせします。`);
      for (const placeTable of gymTable.tables) {
        const messageLines = [];
        messageLines.push(`${placeTable.place}⛹️‍♂️`);
        if (placeTable.placeStatusTable.length === 0) {
            messageLines.push("対象エリアの情報がありませんでした。");
        } else {
            placeTable.placeStatusTable.forEach(areaStatus => {
                messageLines.push(`【${areaStatus.areaName}】`);
                let availableSlots = false;
                areaStatus.validStatusList.forEach((status, index) => {
                    if (status === "○") { // "○" で空きを示すと仮定
                        if (placeTable.reservationTimes[index]) { // 念のため確認
                            messageLines.push(placeTable.reservationTimes[index]);
                        }
                        availableSlots = true;
                    }
                });
                if (!availableSlots) {
                    messageLines.push("本日は空いていません");
                }
            });
        }
        await sendMessage(messageLines.join("\n"));
      }
    }
    console.log("LINEメッセージの送信が完了しました。");

  } catch (error) {
    console.error("getGymStatus関数内でエラーが発生しました:", error);
    // エラーを再スローしてhandler側でキャッチさせる
    throw error;
  } finally {
    if (browser !== null) {
      console.log("ブラウザを閉じます。");
      await browser.close();
    }
  }
}

async function sendMessage(messageText) {
  if (!token || !userId || !groupId) {
    throw new Error("LINE APIの認証情報が不足しています。");
  }

  const response = await fetch("https://api.line.me/v2/bot/message/push", {
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
          text: messageText,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`LINE APIリクエスト失敗: ${response.status} - ${JSON.stringify(errorData)}`);
  }

  const response2 = await fetch ("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
    }, 
    body: JSON.stringify({
        to: groupId,
        messages: [
          {
            type: "text",
            text: message,
          },
        ],
    }),
  });
  if (!response2.ok) {
    const errorData = await response2.json();
    throw new Error(`LINE APIリクエスト失敗: ${response2.status} - ${JSON.stringify(errorData)}`);
  }
}
