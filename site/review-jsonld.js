/* G2: publish Review/AggregateRating JSON-LD from the live review set.
 *
 * The static host bakes this JSON-LD at build time, so a review that is
 * published after the last deploy would never reach crawlers. The marketing
 * pages are already hydrated client-side, so this refreshes the block from the
 * same public endpoint the reviews page uses. It only touches review-eligible
 * pages and does nothing when there is nothing to say.
 */
(function () {
  var PAGES = { "/": 1, "/price/": 1, "/buy/": 1, "/reviews/": 1, "/sms-verification/": 1 };
  var path = location.pathname.replace(/\/index\.html$/, "/");
  if (path !== "/" && path.charAt(path.length - 1) !== "/") path += "/";
  if (!PAGES[path]) return;

  function build(d) {
    var rating = d && d.rating;
    var items = (d && d.items) || [];
    if (!rating && !items.length) return null;
    var node = {
      "@context": "https://schema.org", "@type": "Product",
      name: "SMSPin — Online SMS Verification",
      url: location.origin + path,
    };
    if (rating && Number(rating.reviewCount) > 0) {
      node.aggregateRating = {
        "@type": "AggregateRating", ratingValue: rating.ratingValue,
        reviewCount: rating.reviewCount, bestRating: rating.bestRating || 5,
        worstRating: rating.worstRating || 1,
      };
    }
    var reviews = items.slice(0, 10).map(function (r) {
      var rev = {
        "@type": "Review",
        author: { "@type": "Person", name: r.author || "Customer" },
        reviewRating: { "@type": "Rating", ratingValue: r.rating, bestRating: 5, worstRating: 1 },
        reviewBody: r.body || "",
        datePublished: String(r.created_at || "").slice(0, 10),
      };
      if (r.title) rev.name = r.title;
      return rev;
    });
    if (reviews.length) node.review = reviews;
    return node;
  }

  function apply(data) {
    var node = build(data);
    if (!node) return;
    var olds = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < olds.length; i++) {
      if (olds[i].textContent.indexOf('"AggregateRating"') !== -1) olds[i].remove();
    }
    var s = document.createElement("script");
    s.type = "application/ld+json";
    s.textContent = JSON.stringify(node);
    document.head.appendChild(s);
  }

  function load() {
    fetch("/api/reviews?limit=20", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) apply(d); })
      .catch(function () {});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", load);
  } else {
    load();
  }
})();
