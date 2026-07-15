## SUPABASE DUMP

\-- 1. Full table definition as json
\[
{
"column\_name": "id",
"data\_type": "uuid",
"is\_nullable": "NO"
},
{
"column\_name": "user\_id",
"data\_type": "uuid",
"is\_nullable": "NO"
},
{
"column\_name": "role",
"data\_type": "text",
"is\_nullable": "NO"
},
{
"column\_name": "hierarchy\_id",
"data\_type": "uuid",
"is\_nullable": "NO"
},
{
"column\_name": "congregation\_id",
"data\_type": "uuid",
"is\_nullable": "YES"
},
{
"column\_name": "scope\_level",
"data\_type": "text",
"is\_nullable": "NO"
},
{
"column\_name": "status",
"data\_type": "text",
"is\_nullable": "NO"
},
{
"column\_name": "start\_date",
"data\_type": "timestamp with time zone",
"is\_nullable": "NO"
},
{
"column\_name": "end\_date",
"data\_type": "timestamp with time zone",
"is\_nullable": "YES"
},
{
"column\_name": "created\_at",
"data\_type": "timestamp with time zone",
"is\_nullable": "NO"
}
]

\-- 2. RLS status + Policies as json

\[
{
"schemaname": "public",
"tablename": "user\_hierarchy\_access",
"policyname": "Users can read their own access",
"permissive": "PERMISSIVE",
"roles": "{authenticated}",
"cmd": "SELECT",
"qual": "(user\_id = auth.uid())",
"with\_check": null
}
]



\-- -- 3. Grants for anon/authenticated as json

\[
{
"grantee": "postgres",
"privilege\_type": "TRIGGER"
},
{
"grantee": "postgres",
"privilege\_type": "REFERENCES"
},
{
"grantee": "postgres",
"privilege\_type": "TRUNCATE"
},
{
"grantee": "postgres",
"privilege\_type": "DELETE"
},
{
"grantee": "postgres",
"privilege\_type": "UPDATE"
},
{
"grantee": "postgres",
"privilege\_type": "SELECT"
},
{
"grantee": "postgres",
"privilege\_type": "INSERT"
}
]





\-- 3 Auth settings and project Settings



{

&#x20; "project\_url": "https://cwdyixafvylzgtpsfmwr.supabase.co",

&#x20; "anon\_key\_first\_10\_chars": "eyJhbGciOiJI",

&#x20; "auth\_user\_test": {

&#x20;   "id": "2d1c0c9a-b443-4b06-bda7-ee1341188312",

&#x20;   "email": "treasurer@bosmont.test",

&#x20;   "email\_confirmed\_at": "2026-07-14T..."

&#x20; }

}



\-- 5 Full supabase schema as json



\[

&#x20; {

&#x20;   "table\_name": "cashbook\_attachment",

&#x20;   "column\_name": "id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_attachment",

&#x20;   "column\_name": "line\_item\_id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_attachment",

&#x20;   "column\_name": "file\_url",

&#x20;   "data\_type": "text",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_attachment",

&#x20;   "column\_name": "uploaded\_by",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_attachment",

&#x20;   "column\_name": "uploaded\_at",

&#x20;   "data\_type": "timestamp with time zone",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_line\_item",

&#x20;   "column\_name": "id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_line\_item",

&#x20;   "column\_name": "period\_id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_line\_item",

&#x20;   "column\_name": "section",

&#x20;   "data\_type": "text",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_line\_item",

&#x20;   "column\_name": "officer\_id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_line\_item",

&#x20;   "column\_name": "item\_type",

&#x20;   "data\_type": "text",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_line\_item",

&#x20;   "column\_name": "item\_count",

&#x20;   "data\_type": "integer",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_line\_item",

&#x20;   "column\_name": "amount",

&#x20;   "data\_type": "numeric",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_line\_item",

&#x20;   "column\_name": "proof\_status",

&#x20;   "data\_type": "USER-DEFINED",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_line\_item",

&#x20;   "column\_name": "payment\_type",

&#x20;   "data\_type": "text",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_line\_item",

&#x20;   "column\_name": "manual\_reference",

&#x20;   "data\_type": "text",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_period",

&#x20;   "column\_name": "id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_period",

&#x20;   "column\_name": "congregation\_id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_period",

&#x20;   "column\_name": "year",

&#x20;   "data\_type": "integer",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_period",

&#x20;   "column\_name": "month",

&#x20;   "data\_type": "integer",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_period",

&#x20;   "column\_name": "week",

&#x20;   "data\_type": "integer",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_period",

&#x20;   "column\_name": "service",

&#x20;   "data\_type": "text",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_period",

&#x20;   "column\_name": "status",

&#x20;   "data\_type": "USER-DEFINED",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_period",

&#x20;   "column\_name": "submitted\_by",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_period",

&#x20;   "column\_name": "submitted\_at",

&#x20;   "data\_type": "timestamp with time zone",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_period",

&#x20;   "column\_name": "audit\_comment",

&#x20;   "data\_type": "text",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_period",

&#x20;   "column\_name": "created\_at",

&#x20;   "data\_type": "timestamp with time zone",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_period",

&#x20;   "column\_name": "expenses\_total",

&#x20;   "data\_type": "numeric",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_period",

&#x20;   "column\_name": "elder\_approval\_comment",

&#x20;   "data\_type": "text",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "cashbook\_period",

&#x20;   "column\_name": "requestor\_comment",

&#x20;   "data\_type": "text",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "congregations",

&#x20;   "column\_name": "id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "congregations",

&#x20;   "column\_name": "hierarchy\_id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "congregations",

&#x20;   "column\_name": "name",

&#x20;   "data\_type": "text",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "congregations",

&#x20;   "column\_name": "code",

&#x20;   "data\_type": "text",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "congregations",

&#x20;   "column\_name": "eldership\_id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "congregations",

&#x20;   "column\_name": "overseership\_id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "congregations",

&#x20;   "column\_name": "apostleship\_id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "congregations",

&#x20;   "column\_name": "district\_id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "congregations",

&#x20;   "column\_name": "created\_at",

&#x20;   "data\_type": "timestamp with time zone",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "hierarchy\_levels",

&#x20;   "column\_name": "id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "hierarchy\_levels",

&#x20;   "column\_name": "level\_type",

&#x20;   "data\_type": "text",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "hierarchy\_levels",

&#x20;   "column\_name": "name",

&#x20;   "data\_type": "text",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "hierarchy\_levels",

&#x20;   "column\_name": "code",

&#x20;   "data\_type": "text",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "hierarchy\_levels",

&#x20;   "column\_name": "parent\_id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "hierarchy\_levels",

&#x20;   "column\_name": "created\_at",

&#x20;   "data\_type": "timestamp with time zone",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "ho\_district\_assignments",

&#x20;   "column\_name": "id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "ho\_district\_assignments",

&#x20;   "column\_name": "user\_id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "ho\_district\_assignments",

&#x20;   "column\_name": "district\_id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "ho\_district\_assignments",

&#x20;   "column\_name": "assigned\_by",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "ho\_district\_assignments",

&#x20;   "column\_name": "assigned\_at",

&#x20;   "data\_type": "timestamp with time zone",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "officers",

&#x20;   "column\_name": "id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "officers",

&#x20;   "column\_name": "congregation\_id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "officers",

&#x20;   "column\_name": "officer\_code",

&#x20;   "data\_type": "text",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "officers",

&#x20;   "column\_name": "first\_name",

&#x20;   "data\_type": "text",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "officers",

&#x20;   "column\_name": "rank",

&#x20;   "data\_type": "USER-DEFINED",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "officers",

&#x20;   "column\_name": "last\_name",

&#x20;   "data\_type": "text",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "officers",

&#x20;   "column\_name": "is\_active",

&#x20;   "data\_type": "boolean",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "priest\_census",

&#x20;   "column\_name": "id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "priest\_census",

&#x20;   "column\_name": "congregation\_id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "priest\_census",

&#x20;   "column\_name": "priest\_id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "priest\_census",

&#x20;   "column\_name": "year",

&#x20;   "data\_type": "integer",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "priest\_census",

&#x20;   "column\_name": "month",

&#x20;   "data\_type": "integer",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "priest\_census",

&#x20;   "column\_name": "underdeacon\_count",

&#x20;   "data\_type": "integer",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "priest\_census",

&#x20;   "column\_name": "children\_under\_15",

&#x20;   "data\_type": "integer",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "priest\_census",

&#x20;   "column\_name": "youth\_under\_26",

&#x20;   "data\_type": "integer",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "priest\_census",

&#x20;   "column\_name": "youth\_under\_35",

&#x20;   "data\_type": "integer",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "priest\_census",

&#x20;   "column\_name": "adults\_under\_60",

&#x20;   "data\_type": "integer",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "priest\_census",

&#x20;   "column\_name": "seniors\_60\_plus",

&#x20;   "data\_type": "integer",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "priest\_census",

&#x20;   "column\_name": "working\_members",

&#x20;   "data\_type": "integer",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "priest\_census",

&#x20;   "column\_name": "captured\_by",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "priest\_census",

&#x20;   "column\_name": "captured\_at",

&#x20;   "data\_type": "timestamp with time zone",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "priest\_census",

&#x20;   "column\_name": "updated\_at",

&#x20;   "data\_type": "timestamp with time zone",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "priest\_census",

&#x20;   "column\_name": "locked",

&#x20;   "data\_type": "boolean",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "priest\_census\_log",

&#x20;   "column\_name": "id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "priest\_census\_log",

&#x20;   "column\_name": "priest\_census\_id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "priest\_census\_log",

&#x20;   "column\_name": "changed\_by",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "priest\_census\_log",

&#x20;   "column\_name": "changed\_at",

&#x20;   "data\_type": "timestamp with time zone",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "priest\_census\_log",

&#x20;   "column\_name": "field\_name",

&#x20;   "data\_type": "text",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "priest\_census\_log",

&#x20;   "column\_name": "old\_value",

&#x20;   "data\_type": "text",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "priest\_census\_log",

&#x20;   "column\_name": "new\_value",

&#x20;   "data\_type": "text",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "user\_hierarchy\_access",

&#x20;   "column\_name": "id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "user\_hierarchy\_access",

&#x20;   "column\_name": "user\_id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "user\_hierarchy\_access",

&#x20;   "column\_name": "role",

&#x20;   "data\_type": "text",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "user\_hierarchy\_access",

&#x20;   "column\_name": "hierarchy\_id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "user\_hierarchy\_access",

&#x20;   "column\_name": "congregation\_id",

&#x20;   "data\_type": "uuid",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "user\_hierarchy\_access",

&#x20;   "column\_name": "scope\_level",

&#x20;   "data\_type": "text",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "user\_hierarchy\_access",

&#x20;   "column\_name": "status",

&#x20;   "data\_type": "text",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "user\_hierarchy\_access",

&#x20;   "column\_name": "start\_date",

&#x20;   "data\_type": "timestamp with time zone",

&#x20;   "is\_nullable": "NO"

&#x20; },

&#x20; {

&#x20;   "table\_name": "user\_hierarchy\_access",

&#x20;   "column\_name": "end\_date",

&#x20;   "data\_type": "timestamp with time zone",

&#x20;   "is\_nullable": "YES"

&#x20; },

&#x20; {

&#x20;   "table\_name": "user\_hierarchy\_access",

&#x20;   "column\_name": "created\_at",

&#x20;   "data\_type": "timestamp with time zone",

&#x20;   "is\_nullable": "NO"

&#x20; }

]

