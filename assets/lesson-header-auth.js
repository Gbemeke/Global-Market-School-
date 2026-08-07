// Global Market School — lesson page header + upsell, auth-aware
//
// Every lesson page ships with a static "Enroll Now" button in the
// header, which is the right default for an anonymous visitor. If the
// person viewing the page turns out to already be a logged-in student,
// this swaps that button for their avatar and name instead, linking to
// their dashboard -- so an enrolled student browsing lessons doesn't
// keep getting pitched to enroll in something they already paid for.
//
// The same idea applies to the "Enroll in the next class" upsell box at
// the end of a track: if the student (or an admin, on their behalf)
// already has that next tier's course_access rows, showing a "Pay Now"
// button would be actively wrong -- they'd be paying again for
// something they already own. That box is swapped for a direct link
// into the class they already have instead.
//
// Fails silently and leaves the default markup in place on any error
// (no session, no Supabase, offline, etc.) -- this is a nice-to-have
// enhancement, never a blocker for reading the lesson underneath it.

(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", function () {
    const navSlot = document.getElementById("nav-auth-slot");
    const upsellSlot = document.getElementById("upsell-slot");
    if ((!navSlot && !upsellSlot) || !window.supabase) return;

    try {
      const sb = window.supabase.createClient(
        "https://djkctbtxnpdkstvznjlf.supabase.co",
        "sb_publishable_4J_RxGdtTL8Uip1cn6XCVg_kdOTcyK8"
      );

      sb.auth.getSession().then(function (res) {
        const session = res && res.data && res.data.session;
        if (!session) return;

        if (navSlot) updateNavSlot(sb, session, navSlot);
        if (upsellSlot) updateUpsellSlot(sb, session, upsellSlot);
      }).catch(function () { /* leave defaults in place */ });
    } catch (e) { /* leave defaults in place */ }
  });

  function updateNavSlot(sb, session, slot) {
    const dashboardHref = slot.getAttribute("data-dashboard-href") || "dashboard.html";

    sb.from("profiles").select("full_name, avatar_url, email").eq("id", session.user.id).single()
      .then(function (res2) {
        const profile = res2 && res2.data;
        const name = (profile && profile.full_name) || session.user.email || "Student";
        const initial = name.charAt(0).toUpperCase();
        const div = document.createElement("div");
        div.textContent = name;
        const safeName = div.innerHTML;

        const avatarInner = (profile && profile.avatar_url)
          ? '<img src="' + profile.avatar_url + '" alt="">'
          : '<span>' + initial + '</span>';

        slot.innerHTML =
          '<a href="' + dashboardHref + '" class="nav-profile">' +
            '<span class="nav-avatar">' + avatarInner + '</span>' +
            '<span class="nav-profile-text"><span class="nav-profile-hi">Welcome back</span><span class="nav-profile-name">' + safeName + '</span></span>' +
          '</a>';

        // On pages with a mobile hamburger menu (currently just the
        // homepage), its own separate "Log In" entry needs hiding too --
        // harmless no-op anywhere this element doesn't exist.
        const mobileLogin = document.querySelector(".nav-login-mobile");
        if (mobileLogin) mobileLogin.style.display = "none";
      })
      .catch(function () { /* leave Enroll Now in place */ });
  }

  function updateUpsellSlot(sb, session, slot) {
    const requiredCourses = (slot.getAttribute("data-required-courses") || "")
      .split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    if (!requiredCourses.length) return;

    sb.from("course_access")
      .select("course_key")
      .eq("user_id", session.user.id)
      .eq("has_access", true)
      .then(function (res) {
        const owned = (res && res.data || []).map(function (r) { return r.course_key; });
        const alreadyHasAccess = requiredCourses.every(function (k) { return owned.indexOf(k) !== -1; });
        if (!alreadyHasAccess) return; // leave the default "Enroll / Pay Now" box in place

        const href = slot.getAttribute("data-owned-href");
        const label = slot.getAttribute("data-owned-label");
        const title = slot.getAttribute("data-owned-title");
        const eyebrow = slot.getAttribute("data-owned-eyebrow") || "Already Enrolled";
        if (!href || !label || !title) return;

        slot.innerHTML =
          '<div>' +
            '<p>' + eyebrow + '</p>' +
            '<h3>' + title + '</h3>' +
          '</div>' +
          '<a href="' + href + '" class="btn-primary">' + label + '</a>';
      })
      .catch(function () { /* leave the default Enroll / Pay Now box in place */ });
  }
})();
