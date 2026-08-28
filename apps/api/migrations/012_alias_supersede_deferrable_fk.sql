-- 012 · Make learned_aliases.superseded_by DEFERRABLE, so schema.md §6.3's
-- supersede-with-penalty policy is actually implementable.
--
-- THE CYCLE THIS BREAKS. Three constraints from migration 005 are individually
-- correct and jointly made the documented policy impossible to execute:
--
--   ux_alias_active               UNIQUE (alias_type, normalized_value, scope_source)
--                                 WHERE status = 'active'
--   alias_superseded_has_target   CHECK ((status = 'superseded') = (superseded_by IS NOT NULL))
--   superseded_by                 REFERENCES learned_aliases(id)
--
-- §6.3 case 2 requires, in one transaction: retire the old row and insert its
-- replacement. But the new row cannot be inserted as `active` until the old one
-- stops being active (ux_alias_active), the old one cannot be marked
-- `superseded` without naming its replacement (alias_superseded_has_target),
-- and it cannot name a replacement that does not exist yet (the FK). Each pair
-- is satisfiable; all three together are not, in any statement order.
--
-- Deferring ONLY the foreign key breaks the cycle at its weakest link: the old
-- row may point at an id that does not exist yet, provided it exists by COMMIT.
-- The unique index and the CHECK keep firing immediately, so neither of the two
-- properties that actually protect the data is weakened — at no point can two
-- active aliases share a key, and at no point can a superseded row have no
-- stated successor.
--
-- Why not the alternatives:
--   · Making ux_alias_active deferrable — Postgres has no partial UNIQUE
--     CONSTRAINT, only a partial unique INDEX, and indexes cannot be deferred.
--   · Revoking the old row instead of superseding it — §6.3 rule 4 is explicit
--     that revocation is NOT supersession: it is terminal, needs a reason, and
--     loses the lineage endpoint 18 exists to show.
--   · Inserting the new row as `superseded` pointing at itself and fixing it up
--     afterwards — three statements and an intermediate state that means nothing,
--     to avoid one honest declaration.
--
-- Found by the first real implementation of upsertAlias (U5). The policy had
-- been specified since Day 2 and written into the schema on Day 3; nothing
-- executed it until now.

ALTER TABLE learned_aliases
  DROP CONSTRAINT learned_aliases_superseded_by_fkey;

ALTER TABLE learned_aliases
  ADD CONSTRAINT learned_aliases_superseded_by_fkey
  FOREIGN KEY (superseded_by) REFERENCES learned_aliases(id)
  DEFERRABLE INITIALLY DEFERRED;
