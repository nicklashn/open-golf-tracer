"""jobs: a lease per claim, and interruptions (lost workers) counted apart from attempts

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-17 12:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = '0006'
down_revision = '0005'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table('jobs') as batch_op:
        batch_op.add_column(sa.Column('lease', sa.String(length=32), nullable=True))
        batch_op.add_column(sa.Column('interruptions', sa.Integer(), server_default='0', nullable=False))


def downgrade() -> None:
    with op.batch_alter_table('jobs') as batch_op:
        batch_op.drop_column('interruptions')
        batch_op.drop_column('lease')
