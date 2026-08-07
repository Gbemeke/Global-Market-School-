// Global Market School — lesson page header, auth-aware
//
// Every lesson page ships with a static "Enroll Now" button in the
// header, which is the right default for an anonymous visitor. If the
// person viewing the page turns out to already be a logged-in student,
// this swaps that button for their avatar and name instead, linking to
// their dashboard -- so an enrolled student browsing lessons doesn't
// keep getting pitched to enroll in something they already paid for.
//
// Fails silently and leaves "Enroll Now" in place on any error (no
// session, no Supabase, offline, etc.) -- this is a nice-to-have
// enhancement, never a blocker for reading the lesson underneath it.

(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", function () {
    const slot = document.getElementById("nav-auth-slot");
    if (!slot || !window.supabase) return;

    const dashboardHref = slot.getAttribute("data-dashboard-href") || "dashboard.html";

    try {
      const sb = window.supabase.createClient(
        "https://djkctbtxnpdkstvznjlf.supabase.co",
        "sb_publishable_4J_RxGdtTL8Uip1cn6XCVg_kdOTcyK8"
      );

      sb.auth.getSession().then(function (res) {
        const session = res && res.data && res.data.session;
        if (!session) return;

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
          })
          .catch(function () { /* leave Enroll Now in place */ });
      }).catch(function () { /* leave Enroll Now in place */ });
    } catch (e) { /* leave Enroll Now in place */ }
  });
})();
