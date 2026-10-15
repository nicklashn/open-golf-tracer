"""ai settings per user

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-15 20:40:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

import golf_api.db

revision = '0002'
down_revision = '0001'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('ai_settings',
    sa.Column('user_id', sa.String(length=40), nullable=False),
    sa.Column('provider', sa.String(length=32), nullable=False),
    sa.Column('model', sa.String(length=120), nullable=False),
    sa.Column('base_url', sa.String(length=300), nullable=False),
    sa.Column('api_key', sa.Text(), nullable=False),
    sa.Column('max_tokens', sa.Integer(), nullable=False),
    sa.Column('updated_at', golf_api.db.UTCDateTime(), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_ai_settings_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('user_id', name=op.f('pk_ai_settings'))
    )


def downgrade() -> None:
    op.drop_table('ai_settings')
