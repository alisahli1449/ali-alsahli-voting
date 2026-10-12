"use strict";

// منصة التقييم والتصويت التفاعلي

let currentState = null;
let adminPassword = "";

const $ = id => document.getElementById(id);

function showMessage(id, message, success = true) {
  const element = $(id);
  if (!element) return;

  element.textContent = message;
  element.style.color = success ? "green" : "red";
}

async function request(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (adminPassword) {
    headers["x-admin-password"] = adminPassword;
  }

  const response = await fetch("/api" + path, {
    ...options,
    headers
  });

  const contentType =
    response.headers.get("content-type") || "";

  let data;

  if (contentType.includes("application/json")) {
    data = await response.json();
  } else {
    data = { message: await response.text() };
  }

  if (!response.ok) {
    throw new Error(
      data.error || data.message || "حدث خطأ في الاتصال"
    );
  }

  return data;
}

// عرض النتائج

function renderResults(data) {
  const container = $("results");
  if (!container) return;

  container.replaceChildren();

  const results = data.results || [];

  if (!Array.isArray(results) || results.length === 0) {
    container.textContent = "لا توجد نتائج حتى الآن";
    return;
  }

  results.forEach(result => {
    const item = document.createElement("div");
    item.className = "result-item";

    const title = document.createElement("h3");
    title.textContent =
      result.group || result.name || "المجموعة";

    const average = document.createElement("p");
    average.textContent =
      "متوسط التقييم: " +
      (Number(result.average) || 0).toFixed(2);

    const count = document.createElement("p");
    count.textContent =
      "عدد المشاركات: " + (result.count || 0);

    item.append(title, average, count);
    container.appendChild(item);
  });
}

// تحديث حالة المنصة

function renderState(data) {
  currentState = data;

  if ($("title")) {
    $("title").textContent =
      data.title || "منصة التقييم والتصويت التفاعلي";
  }

  if ($("status")) {
    $("status").textContent = data.active
      ? "التصويت متاح الآن للمجموعة: " +
        (data.activeGroup || "")
      : "التصويت مغلق حاليًا";
  }

  if ($("nameRow")) {
    $("nameRow").hidden = data.mode !== "named";
  }

  renderResults(data);

  if (adminPassword && $("groupSelect")) {
    const select = $("groupSelect");
    const previous = select.value;

    select.replaceChildren();

    (data.groups || []).forEach(group => {
      const option = document.createElement("option");
      option.value = group;
      option.textContent = group;
      select.appendChild(option);
    });

    if (
      [...select.options].some(
        option => option.value === previous
      )
    ) {
      select.value = previous;
    }
  }
}

// تحميل البيانات

async function loadState() {
  try {
    const data = await request("/state");
    renderState(data);
  } catch (error) {
    showMessage("status", error.message, false);
  }
}

// إرسال التصويت

if ($("vote")) {
  $("vote").addEventListener("submit", async event => {
    event.preventDefault();

    const form = event.currentTarget;
    const values = new FormData(form);

    const code = String(
      values.get("code") || ""
    ).trim();

    const name = String(
      values.get("name") || ""
    ).trim();

    const score = Number(values.get("score"));

    if (!currentState?.active) {
      showMessage(
        "voteMsg",
        "التصويت مغلق حاليًا",
        false
      );
      return;
    }

    if (!code) {
      showMessage(
        "voteMsg",
        "أدخل رمز المشاركة",
        false
      );
      return;
    }

    if (
      !Number.isInteger(score) ||
      score < 1 ||
      score > 10
    ) {
      showMessage(
        "voteMsg",
        "اختر درجة من 1 إلى 10",
        false
      );
      return;
    }

    if (
      currentState.mode === "named" &&
      !name
    ) {
      showMessage(
        "voteMsg",
        "أدخل اسم المشارك",
        false
      );
      return;
    }

    try {
      await request("/vote", {
        method: "POST",
        body: JSON.stringify({
          code,
          name,
          score
        })
      });

      showMessage(
        "voteMsg",
        "تم إرسال تقييمك بنجاح"
      );

      form.reset();
      await loadState();

    } catch (error) {
      showMessage(
        "voteMsg",
        error.message,
        false
      );
    }
  });
}

// تسجيل دخول المدرب

if ($("adminLogin")) {
  $("adminLogin").addEventListener(
    "submit",
    async event => {
      event.preventDefault();

      const password =
        $("adminPassword")?.value || "";

      if (!password) {
        showMessage(
          "adminMsg",
          "أدخل كلمة مرور المدرب",
          false
        );
        return;
      }

      try {
        // يجب أن يتحقق الخادم من كلمة المرور
        // قبل السماح بأي إجراء إداري.
        await request("/admin/login", {
          method: "POST",
          body: JSON.stringify({ password })
        });

        adminPassword = password;

        if ($("adminPanel")) {
          $("adminPanel").hidden = false;
        }

        showMessage(
          "adminMsg",
          "تم تسجيل الدخول بنجاح"
        );

        await loadState();

      } catch (error) {
        showMessage(
          "adminMsg",
          error.message,
          false
        );
      }
    }
  );
}

// تشغيل التصويت

if ($("startVoting")) {
  $("startVoting").addEventListener(
    "click",
    async () => {
      const group = $("groupSelect")?.value;

      if (!group) {
        showMessage(
          "adminMsg",
          "اختر المجموعة أولًا",
          false
        );
        return;
      }

      try {
        await request("/admin/start", {
          method: "POST",
          body: JSON.stringify({ group })
        });

        showMessage(
          "adminMsg",
          "تم فتح التصويت"
        );

        await loadState();

      } catch (error) {
        showMessage(
          "adminMsg",
          error.message,
          false
        );
      }
    }
  );
}

// إغلاق التصويت

if ($("stopVoting")) {
  $("stopVoting").addEventListener(
    "click",
    async () => {
      try {
        await request("/admin/stop", {
          method: "POST"
        });

        showMessage(
          "adminMsg",
          "تم إغلاق التصويت"
        );

        await loadState();

      } catch (error) {
        showMessage(
          "adminMsg",
          error.message,
          false
        );
      }
    }
  );
}

// تغيير نوع التصويت

if ($("votingMode")) {
  $("votingMode").addEventListener(
    "change",
    async event => {
      const mode = event.target.value;

      try {
        await request("/admin/mode", {
          method: "POST",
          body: JSON.stringify({ mode })
        });

        showMessage(
          "adminMsg",
          "تم تحديث نوع التصويت"
        );

        await loadState();

      } catch (error) {
        showMessage(
          "adminMsg",
          error.message,
          false
        );
      }
    }
  );
}

// تحديث النتائج تلقائيًا

loadState();

setInterval(() => {
  loadState();
}, 5000);
