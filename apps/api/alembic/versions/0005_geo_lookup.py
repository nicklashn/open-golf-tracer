"""users: may a video's GPS be looked up on OpenStreetMap on its own (default on)

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-17 21:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = '0005'
down_revision = '0004'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table('users') as batch_op:
        batch_op.add_column(sa.Column('geo_lookup', sa.Boolean(), server_default='1', nullable=False))


def downgrade() -> None:
    with op.batch_alter_table('users') as batch_op:
        batch_op.drop_column('geo_lookup')
