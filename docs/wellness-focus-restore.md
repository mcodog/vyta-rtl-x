# Restoring "Shop by Wellness Focus"

The "Shop by Wellness Focus" section (six category tiles under the hero) is
hidden from the home page. Only its mount point was removed; the component
itself is untouched at `components/home/WellnessFocus.tsx`, so nothing else
needs rebuilding.

## Put it back

In `app/page.tsx`:

1. Re-add the import with the other home sections:

   ```tsx
   import WellnessFocus from '@/components/home/WellnessFocus';
   ```

2. Render it directly after `<Hero />`:

   ```tsx
   <Hero />
   <WellnessFocus />
   <BestSellers />
   ```

3. Delete the "Shop by Wellness Focus … hidden too" paragraph from the
   `Home` doc comment.

Or revert the commit that hid it:

```bash
git log --oneline -- app/page.tsx   # find "Hide Shop by Wellness Focus"
git revert <sha>
```

## What it depends on (all still in place)

- **Categories:** tiles come from Admin → Categories (featured ones first, up
  to six) via `getStoreCategories({ featuredOnly: true })` in
  `lib/categories`. With no featured categories it shows the built-in six
  fallbacks in the component.
- **Tile art:** `tile 1.png` … `tile 6.png` in the Supabase `assets` public
  bucket, assigned by position (first category gets `tile 1.png`, and so on).
  Missing images fall back to the navy→teal gradients.
- **Links:** each tile links to `/products?category=<slug>`.
