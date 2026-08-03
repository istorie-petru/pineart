"""Tag endpoints: CRUD, the graph payload, and graph rules."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Item, ItemTag, Tag, TagCategory, TagGraphRule
from ..schemas import (
    GraphEdge,
    GraphNode,
    ItemPage,
    TagCategoryIn,
    TagCategoryOut,
    TagCategoryPatch,
    TagGraph,
    TagGraphRuleIn,
    TagGraphRuleOut,
    TagGraphRulePatch,
    TagIn,
    TagMergeIn,
    TagMergeResult,
    TagOut,
    TagPatch,
    TagSuggestion,
)
from ..serializers import item_out
from ..services import queries, search, settings_store
from ..services import tags as tag_service

router = APIRouter(prefix="/api/tags", tags=["tags"])


@router.get("", response_model=list[TagOut])
def list_tags(db: Session = Depends(get_db)) -> list[TagOut]:
    return [TagOut.model_validate(t) for t in db.scalars(select(Tag).order_by(Tag.name)).all()]


@router.post("", response_model=TagOut, status_code=201)
def create_tag(payload: TagIn, db: Session = Depends(get_db)) -> TagOut:
    if payload.category_id is not None and db.get(TagCategory, payload.category_id) is None:
        raise HTTPException(status_code=404, detail="Category not found")
    tag = tag_service.get_or_create(
        db, payload.name, payload.color, payload.category_id, payload.link_url
    )
    db.commit()
    db.refresh(tag)
    return TagOut.model_validate(tag)


@router.get("/suggest", response_model=list[TagSuggestion])
def suggest(q: str = "", limit: int = 12, db: Session = Depends(get_db)) -> list[TagSuggestion]:
    """Tags similar to a partial query — the autocomplete behind every tag input.

    Server-side rather than filtering a cached list in the browser, because the
    matching depends on the same slug normalization the rest of the backend uses;
    duplicating it in TypeScript would be two implementations to keep in step.
    """
    return [
        TagSuggestion(
            id=tag.id,
            name=tag.name,
            slug=tag.slug,
            color=tag.color,
            category=TagCategoryOut.model_validate(tag.category) if tag.category else None,
            link_url=tag.link_url,
            usage_count=count,
        )
        for tag, count in tag_service.suggest(db, q, max(1, min(limit, 50)))
    ]


@router.get("/graph", response_model=TagGraph)
def graph(db: Session = Depends(get_db)) -> TagGraph:
    """Nodes and edges as plain JSON; all physics and layout are client-side."""
    tags, edges = tag_service.graph(db)
    counts = tag_service.usage_counts(db)
    return TagGraph(
        nodes=[
            GraphNode(
                id=t.id,
                name=t.name,
                color=t.color,
                category=TagCategoryOut.model_validate(t.category) if t.category else None,
                link_url=t.link_url,
                usage_count=counts.get(t.id, 0),
            )
            for t in tags
        ],
        edges=[GraphEdge(source=a, target=b, weight=w) for a, b, w in edges],
    )


# ---------------------------------------------------------------------------
# Categories. Declared before the `/{tag_id}` routes below: FastAPI matches
# routes in registration order, and if the int-typed `/{tag_id}` path were
# registered first, a request to `/categories` would be tried against it,
# fail int conversion, and 422 before ever reaching the routes here.
# ---------------------------------------------------------------------------


@router.get("/categories", response_model=list[TagCategoryOut])
def list_categories(db: Session = Depends(get_db)) -> list[TagCategoryOut]:
    categories = db.scalars(select(TagCategory).order_by(TagCategory.position, TagCategory.name)).all()
    return [TagCategoryOut.model_validate(c) for c in categories]


@router.post("/categories", response_model=TagCategoryOut, status_code=201)
def create_category(payload: TagCategoryIn, db: Session = Depends(get_db)) -> TagCategoryOut:
    category = tag_service.get_or_create_category(
        db, payload.name, payload.color, payload.links_enabled
    )
    db.commit()
    db.refresh(category)
    return TagCategoryOut.model_validate(category)


@router.patch("/categories/{category_id}", response_model=TagCategoryOut)
def patch_category(
    category_id: int, payload: TagCategoryPatch, db: Session = Depends(get_db)
) -> TagCategoryOut:
    category = db.get(TagCategory, category_id)
    if category is None:
        raise HTTPException(status_code=404, detail="Category not found")

    if payload.name is not None and payload.name.strip() != category.name:
        new_name = " ".join(payload.name.split())
        new_slug = tag_service.slugify(new_name)
        clash = db.scalar(
            select(TagCategory).where(
                (func.lower(TagCategory.name) == new_name.lower()) | (TagCategory.slug == new_slug),
                TagCategory.id != category_id,
            )
        )
        if clash:
            raise HTTPException(
                status_code=409,
                detail=f"'{clash.name}' already uses that name or its normalized form ({new_slug})",
            )
        category.name = new_name
        category.slug = new_slug
    if payload.color is not None:
        category.color = payload.color
    if payload.links_enabled is not None:
        category.links_enabled = payload.links_enabled
    db.commit()
    db.refresh(category)
    return TagCategoryOut.model_validate(category)


@router.delete("/categories/{category_id}", status_code=204)
def delete_category(category_id: int, db: Session = Depends(get_db)) -> None:
    """Delete a category. Tags under it are not deleted — they fall back to
    uncategorized (`ON DELETE SET NULL`), the same way deleting a tag relation
    never touches the tags it related. Any graph rule naming this category
    cascades away with it (`tag_graph_rules` FKs are `ON DELETE CASCADE`)."""
    category = db.get(TagCategory, category_id)
    if category is None:
        raise HTTPException(status_code=404, detail="Category not found")
    db.delete(category)
    db.commit()


def _require_distinct_categories(from_id: int, to_id: int, via_id: int) -> None:
    if len({from_id, to_id, via_id}) != 3:
        raise HTTPException(status_code=400, detail="Pick three different categories")


def _rule_out(rule: TagGraphRule, categories: dict[int, TagCategory]) -> TagGraphRuleOut:
    from_cat = categories[rule.from_category_id]
    to_cat = categories[rule.to_category_id]
    via_cat = categories[rule.via_category_id]
    name = rule.name or f"{from_cat.name} ✕ {to_cat.name} via {via_cat.name}"
    return TagGraphRuleOut(
        id=rule.id,
        name=name,
        from_category=TagCategoryOut.model_validate(from_cat),
        to_category=TagCategoryOut.model_validate(to_cat),
        via_category=TagCategoryOut.model_validate(via_cat),
    )


@router.get("/graph-rules", response_model=list[TagGraphRuleOut])
def list_graph_rules(db: Session = Depends(get_db)) -> list[TagGraphRuleOut]:
    rules = db.scalars(select(TagGraphRule)).all()
    all_categories = {c.id: c for c in db.scalars(select(TagCategory)).all()}
    return [_rule_out(r, all_categories) for r in rules]


@router.post("/graph-rules", response_model=TagGraphRuleOut, status_code=201)
def create_graph_rule(payload: TagGraphRuleIn, db: Session = Depends(get_db)) -> TagGraphRuleOut:
    _require_distinct_categories(payload.from_category_id, payload.to_category_id, payload.via_category_id)
    ids = (payload.from_category_id, payload.to_category_id, payload.via_category_id)
    categories = {cid: db.get(TagCategory, cid) for cid in set(ids)}
    for cid, category in categories.items():
        if category is None:
            raise HTTPException(status_code=404, detail=f"Category {cid} not found")

    existing = db.scalar(
        select(TagGraphRule).where(
            TagGraphRule.from_category_id == payload.from_category_id,
            TagGraphRule.to_category_id == payload.to_category_id,
            TagGraphRule.via_category_id == payload.via_category_id,
        )
    )
    if existing:
        rule = existing
    else:
        rule = TagGraphRule(
            name=(payload.name or "").strip() or None,
            from_category_id=payload.from_category_id,
            to_category_id=payload.to_category_id,
            via_category_id=payload.via_category_id,
        )
        db.add(rule)
        db.commit()
        db.refresh(rule)

    return _rule_out(rule, categories)


@router.patch("/graph-rules/{rule_id}", response_model=TagGraphRuleOut)
def patch_graph_rule(
    rule_id: int, payload: TagGraphRulePatch, db: Session = Depends(get_db)
) -> TagGraphRuleOut:
    rule = db.get(TagGraphRule, rule_id)
    if rule is None:
        raise HTTPException(status_code=404, detail="Rule not found")

    new_from = payload.from_category_id if payload.from_category_id is not None else rule.from_category_id
    new_to = payload.to_category_id if payload.to_category_id is not None else rule.to_category_id
    new_via = payload.via_category_id if payload.via_category_id is not None else rule.via_category_id
    _require_distinct_categories(new_from, new_to, new_via)

    ids = (new_from, new_to, new_via)
    categories = {cid: db.get(TagCategory, cid) for cid in set(ids)}
    for cid, category in categories.items():
        if category is None:
            raise HTTPException(status_code=404, detail=f"Category {cid} not found")

    clash = db.scalar(
        select(TagGraphRule).where(
            TagGraphRule.from_category_id == new_from,
            TagGraphRule.to_category_id == new_to,
            TagGraphRule.via_category_id == new_via,
            TagGraphRule.id != rule_id,
        )
    )
    if clash:
        raise HTTPException(status_code=409, detail="A rule for these categories already exists")

    rule.from_category_id = new_from
    rule.to_category_id = new_to
    rule.via_category_id = new_via
    if payload.name is not None:
        rule.name = payload.name.strip() or None
    db.commit()
    db.refresh(rule)

    return _rule_out(rule, categories)


@router.delete("/graph-rules/{rule_id}", status_code=204)
def delete_graph_rule(rule_id: int, db: Session = Depends(get_db)) -> None:
    rule = db.get(TagGraphRule, rule_id)
    if rule is None:
        raise HTTPException(status_code=404, detail="Rule not found")
    db.delete(rule)
    db.commit()


@router.get("/unused", response_model=list[TagOut])
def unused_tags(db: Session = Depends(get_db)) -> list[TagOut]:
    """Tags with zero items attached — the orphaned-tag cleanup list.

    Declared before `/{tag_id}` for the same reason `/categories` is above:
    FastAPI matches routes in registration order, and an int-typed `/{tag_id}`
    registered first would 422 on this literal path before ever reaching it.

    Distinct from `/suggest`'s usage counts (which only cover non-deleted
    items for the graph): a tag is only truly orphaned when it has no rows in
    `item_tags` at all, deleted items included, since a soft-deleted item can
    still be restored from Trash and would make the tag "used" again.
    """
    used_ids = select(ItemTag.tag_id).distinct()
    tags = db.scalars(select(Tag).where(Tag.id.not_in(used_ids)).order_by(Tag.name)).all()
    return [TagOut.model_validate(t) for t in tags]


@router.get("/{tag_id}", response_model=TagOut)
def get_tag(tag_id: int, db: Session = Depends(get_db)) -> TagOut:
    tag = db.get(Tag, tag_id)
    if tag is None:
        raise HTTPException(status_code=404, detail="Tag not found")
    return TagOut.model_validate(tag)


@router.patch("/{tag_id}", response_model=TagOut)
def patch_tag(tag_id: int, payload: TagPatch, db: Session = Depends(get_db)) -> TagOut:
    """Rename / recolour, used by the graph's inline editor.

    Renaming is safe by construction: every foreign key references `tags.id`, so
    no item assignment or dynamic-board query is orphaned by a name change. Only
    the FTS index stores the name as text, which is why the affected items are
    reindexed here.
    """
    tag = db.get(Tag, tag_id)
    if tag is None:
        raise HTTPException(status_code=404, detail="Tag not found")

    if payload.name is not None and payload.name.strip() != tag.name:
        new_name = " ".join(payload.name.split())
        new_slug = tag_service.slugify(new_name)
        # The slug is checked as well as the name: "Shoyo Hinata" and
        # "Shōyō Hinata" are different strings that mean the same tag, and
        # letting both exist would defeat the point of having a slug — and would
        # fail later with a raw IntegrityError instead of this message.
        clash = db.scalar(
            select(Tag).where(
                (func.lower(Tag.name) == new_name.lower()) | (Tag.slug == new_slug),
                Tag.id != tag_id,
            )
        )
        if clash:
            raise HTTPException(
                status_code=409,
                detail=f"'{clash.name}' already uses that name or its normalized form ({new_slug})",
            )
        tag.name = new_name
        tag.slug = new_slug
    if payload.color is not None:
        tag.color = payload.color
    # link_url has to distinguish "not sent" from "sent empty to clear" — the
    # validator folds "" to None, so an `is not None` check (fine for the other
    # fields here) would make clearing a link indistinguishable from omitting
    # it. `model_fields_set` says whether the key was in the request at all.
    if "link_url" in payload.model_fields_set:
        tag.link_url = payload.link_url
    if payload.clear_category:
        tag.category_id = None
    elif payload.category_id is not None:
        if db.get(TagCategory, payload.category_id) is None:
            raise HTTPException(status_code=404, detail="Category not found")
        tag.category_id = payload.category_id
    db.commit()
    db.refresh(tag)

    for item in db.scalars(select(Item).join(Item.tags).where(Tag.id == tag_id)).all():
        search.reindex_item(db, item)
    return TagOut.model_validate(tag)


@router.post("/{tag_id}/merge", response_model=TagMergeResult)
def merge_tag(tag_id: int, payload: TagMergeIn, db: Session = Depends(get_db)) -> TagMergeResult:
    """Collapse two tag identities into one.

    Distinct from rename (`PATCH /{tag_id}`): rename changes what one tag is
    called, merge fixes having accidentally created two of them ("landscape" /
    "landscapes"). Every `item_tags` row pointing at the merged-away tag is
    reassigned to the target tag, duplicates are dropped rather than violating
    the (item_id, tag_id) primary key, and the merged-away tag is deleted — all
    in one transaction, so a crash partway through can't leave some items
    pointing at a tag that no longer exists.
    """
    if tag_id == payload.into_tag_id:
        raise HTTPException(status_code=400, detail="Cannot merge a tag into itself")

    source = db.get(Tag, tag_id)
    target = db.get(Tag, payload.into_tag_id)
    if source is None or target is None:
        raise HTTPException(status_code=404, detail="Tag not found")

    already_tagged = {
        row
        for row in db.scalars(
            select(ItemTag.item_id).where(ItemTag.tag_id == target.id)
        ).all()
    }
    source_item_ids = list(
        db.scalars(select(ItemTag.item_id).where(ItemTag.tag_id == source.id)).all()
    )

    # `item_tags` has no surrogate key — (item_id, tag_id) *is* the primary key —
    # so "reassign" can't be an UPDATE that mutates half of a composite PK in
    # place (SQLAlchemy's unit-of-work does not reliably support that). Delete
    # the old pairing and insert the new one instead: still one transaction,
    # still atomic, just expressed as core delete+insert rather than an ORM
    # attribute mutation.
    reassigned = 0
    for item_id in source_item_ids:
        db.execute(
            ItemTag.__table__.delete().where(
                ItemTag.item_id == item_id, ItemTag.tag_id == source.id
            )
        )
        if item_id not in already_tagged:
            db.execute(ItemTag.__table__.insert().values(item_id=item_id, tag_id=target.id))
            reassigned += 1

    db.delete(source)
    db.commit()

    for item in db.scalars(select(Item).where(Item.id.in_(source_item_ids))).all():
        search.reindex_item(db, item)

    return TagMergeResult(
        merged_tag_id=tag_id, into_tag_id=target.id, items_reassigned=reassigned
    )


@router.delete("/{tag_id}", status_code=204)
def delete_tag(tag_id: int, db: Session = Depends(get_db)) -> None:
    tag = db.get(Tag, tag_id)
    if tag is None:
        raise HTTPException(status_code=404, detail="Tag not found")
    affected = list(db.scalars(select(Item).join(Item.tags).where(Tag.id == tag_id)).all())
    db.delete(tag)
    db.commit()
    for item in affected:
        search.reindex_item(db, item)


@router.get("/{tag_id}/items", response_model=ItemPage)
def items_for_tag(
    tag_id: int,
    db: Session = Depends(get_db),
    cursor: str | None = None,
    limit: int | None = None,
) -> ItemPage:
    tag = db.get(Tag, tag_id)
    if tag is None:
        raise HTTPException(status_code=404, detail="Tag not found")
    parsed = search.ParsedQuery(tags=[tag.name.lower()])
    stmt = queries.build_query(db, parsed=parsed)
    page_size = limit or int(settings_store.get(db, "collection.page_size"))
    items, next_cursor, total = queries.paginate(db, stmt, limit=page_size, cursor=cursor)
    return ItemPage(items=[item_out(i) for i in items], next_cursor=next_cursor, total=total)
