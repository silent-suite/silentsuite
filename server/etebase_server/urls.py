from django.conf import settings
from django.contrib import admin
from django.urls import path
from django.views.generic import TemplateView

urlpatterns = [
    path("", TemplateView.as_view(template_name="success.html")),
]

if not settings.ETEBASE_DISABLE_DJANGO_ADMIN:
    urlpatterns.insert(0, path("admin/", admin.site.urls))
